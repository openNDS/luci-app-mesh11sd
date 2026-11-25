'use strict';
'require baseclass';
'require rpc';
'require view.mesh11sd.common as common';

/*
 * Status > Overview section: the live state of mesh11sd and the wireless interfaces.
 *
 * LuCI's own Wireless section reads the saved configuration, which does not have what
 * mesh11sd applied without writing flash. This reads the running state instead:
 * "ubus call mesh11sd status" for the node and its mesh interfaces, and luci-rpc
 * getWirelessDevices for the wireless interfaces netifd runs. getWirelessDevices is
 * network.wireless status per radio, with each interface's iwinfo (live mode and SSID) added;
 * luci-base already grants it to every LuCI session, so no ACL entry of our own is needed.
 * iwinfo assoclist is used only for the mesh-point signal icon (the strongest peer);
 * the rpcd ACL can read it. No keys are shown.
 */

var callWirelessDevices = rpc.declare({
	object: 'luci-rpc',
	method: 'getWirelessDevices',
	expect: { '': {} }
});

var callAssocList = rpc.declare({
	object: 'iwinfo',
	method: 'assoclist',
	params: [ 'device' ],
	expect: { results: [] }
});

return baseclass.extend({
	title: _('Mesh11sd'),

	load: function() {
		return Promise.all([
			common.getStatus(),
			L.resolveDefault(callWirelessDevices(), {})
		]).then(function(data) {
			var wifi = data[1] || {};
			var assoc = {};
			var tasks = [];

			Object.keys(wifi).forEach(function(radio) {
				(wifi[radio].interfaces || []).forEach(function(i) {
					if (!i.ifname)
						return;
					tasks.push(L.resolveDefault(callAssocList(i.ifname), { results: [] }).then(function(res) {
						assoc[i.ifname] = (res && res.results) ? res.results : [];
					}));
				});
			});

			return Promise.all(tasks).then(function() {
				return [ data[0], wifi, assoc ];
			});
		});
	},

	table: function(titles, rows, empty) {
		var t = E('table', { 'class': 'table' }, [
			E('tr', { 'class': 'tr table-titles' }, titles.map(function(h) {
				return E('th', { 'class': 'th' }, h);
			}))
		]);

		if (!rows.length) {
			rows = [ [ E('em', empty) ] ];
		}
		rows.forEach(function(r) {
			t.appendChild(E('tr', { 'class': 'tr' }, r.map(function(c) {
				return E('td', { 'class': 'td' }, c);
			})));
		});
		return t;
	},

	pairs: function(rows) {
		return E('table', { 'class': 'table' }, rows.map(function(r) {
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left', 'width': '33%' }, r[0]),
				E('td', { 'class': 'td left' }, r[1])
			]);
		}));
	},

	autoConfigText: function(setup) {
		var v = (setup.running_auto_config != null) ? setup.running_auto_config : setup.auto_config;

		if (String(setup.auto_config_test) == '1') {
			return _('confidence test running');
		}
		return { '0': _('off'), '1': _('on'), '2': _('on, commit all') }[String(v)] || common.text(v);
	},

	/* "36 (5.180 GHz)" from iwinfo channel and frequency (MHz) */
	channelText: function(iw) {
		if (!iw.channel) {
			return null;
		}
		return iw.frequency ? '%d (%.3f %s)'.format(iw.channel, iw.frequency / 1000, _('GHz')) : String(iw.channel);
	},

	/*
	 * Signal icon as in luci-mod-status 60_wifi.js: quality 0 / <25 / <50 / <75 / else,
	 * or signal-none when the interface is down.
	 */
	signalIcon: function(quality, title, down) {
		var icon;

		if (down)
			icon = L.resource('icons/signal-none.svg');
		else if (quality <= 0)
			icon = L.resource('icons/signal-000-000.svg');
		else if (quality < 25)
			icon = L.resource('icons/signal-000-025.svg');
		else if (quality < 50)
			icon = L.resource('icons/signal-025-050.svg');
		else if (quality < 75)
			icon = L.resource('icons/signal-050-075.svg');
		else
			icon = L.resource('icons/signal-075-100.svg');

		return E('img', { 'src': icon, 'title': title || '' });
	},

	/*
	 * Quality percent and tooltip for one interface.
	 * Access points: iwinfo quality / quality_max, the same as LuCI's own SSID badge
	 * (getSignalPercent). Mesh points: the strongest peer's signal from the assoclist,
	 * converted with the Associated Stations formula, min((signal + 110) / 70 * 100, 100).
	 * With no peers, or if the assoclist is missing, fall back to the iwinfo quality.
	 */
	ifaceSignal: function(iw, peers, isMesh, down) {
		var best = null;
		var i, q;

		if (down)
			return { quality: 0, title: '', down: true };

		peers = peers || [];
		for (i = 0; i < peers.length; i++) {
			if (peers[i].signal != null && (best == null || peers[i].signal > best))
				best = peers[i].signal;
		}

		if (isMesh && best != null) {
			q = Math.min((best + 110) / 70 * 100, 100);
			return {
				quality: q,
				title: '%s: %d %s / %s: %d%%'.format(_('Strongest peer'), best, _('dBm'), _('Quality'), q),
				down: false
			};
		}

		if (iw.quality > 0 && iw.quality_max > 0) {
			q = Math.floor((100 / iw.quality_max) * iw.quality);
			return {
				quality: q,
				title: '%s: %d %s / %s: %d%%'.format(_('Signal'), iw.signal || 0, _('dBm'), _('Quality'), q),
				down: false
			};
		}

		return { quality: 0, title: '%s: %d%%'.format(_('Quality'), 0), down: false };
	},

	/*
	 * One box per radio, in the markup of LuCI's own Wireless section (ifacebox), with a green
	 * head while the radio is up: the radio's type, channel, country, noise and TX power from
	 * its iwinfo, then each interface netifd runs on it with a signal icon, its live SSID or
	 * mesh ID, mode and state.
	 */
	radioBoxes: function(wifi, assoc) {
		var self = this;
		var boxes = E('div', { 'class': 'network-status-table' });
		var green = '--zone-color-rgb:46,160,67; background:rgb(46,160,67); color:#fff';
		var modes = { 'ap': _('Access point'), 'mesh': _('Mesh point'), 'sta': _('Client') };
		var iwModes = { 'Master': _('Access point'), 'Mesh Point': _('Mesh point'), 'Client': _('Client') };

		Object.keys(wifi || {}).sort().forEach(function(radio) {
			var r = wifi[radio] || {};
			var iw = r.iwinfo || {};
			var c = r.config || {};
			var hw = (iw.hardware && iw.hardware.name) ? iw.hardware.name : c.type;

			boxes.appendChild(E('div', { 'class': 'ifacebox' }, [
				E('div', { 'class': 'ifacebox-head center', 'style': r.up ? green : null },
					E('strong', radio)),
				E('div', { 'class': 'ifacebox-body left' }, [
					L.itemlist(E('span'), [
						_('Type'), hw ? String(hw).replace(/^Generic | Wireless Controller .+$/g, '') : null,
						_('Channel'), self.channelText(iw),
						_('Country Code'), iw.country || c.country || null,
						_('Noise'), iw.noise ? '%d %s'.format(iw.noise, _('dBm')) : null,
						_('TX Power'), iw.txpower ? '%d %s'.format(iw.txpower, _('dBm')) : null
					]),
					E('div', {}, (r.interfaces || []).map(function(i) {
						var ic = i.config || {};
						var iiw = i.iwinfo || {};
						var up = r.up && i.ifname && !ic.disabled;
						var ssid = iiw.ssid || (ic.mode == 'mesh' ? ic.mesh_id : ic.ssid);
						var mode = iwModes[iiw.mode] || iiw.mode || modes[ic.mode] || common.text(ic.mode);
						var isMesh = (ic.mode == 'mesh' || iiw.mode == 'Mesh Point');
						var sig = self.ifaceSignal(iiw, (assoc || {})[i.ifname], isMesh, !up);

						return E('div', { 'class': 'ifacebadge', 'style': 'display:block; margin-top:.25em' }, [
							self.signalIcon(sig.quality, sig.title, sig.down), ' ',
							E('strong', common.text(ssid)), ' ', mode, ' ',
							E('span', { 'style': 'font-weight:bold; color:' + (up ? 'rgb(46,160,67)' : 'grey') },
								up ? _('up') : _('down'))
						]);
					}))
				])
			]));
		});

		return boxes.firstElementChild ? boxes : E([]);
	},

	/*
	 * The wireless interfaces netifd runs: [ ssid or mesh id, mode, interface, radio, network,
	 * state ]. The live iwinfo mode and SSID where present, else the configuration's.
	 */
	wifiRows: function(wifi) {
		var rows = [];
		var modes = { 'ap': _('Access point'), 'mesh': _('Mesh point'), 'sta': _('Client') };
		var iwModes = { 'Master': _('Access point'), 'Mesh Point': _('Mesh point'), 'Client': _('Client') };

		Object.keys(wifi || {}).sort().forEach(function(radio) {
			var r = wifi[radio] || {};

			(r.interfaces || []).forEach(function(i) {
				var c = i.config || {};
				var iw = i.iwinfo || {};
				var up = r.up && i.ifname && !c.disabled;
				var ssid = iw.ssid || (c.mode == 'mesh' ? c.mesh_id : c.ssid);

				rows.push([
					common.text(ssid),
					iwModes[iw.mode] || iw.mode || modes[c.mode] || common.text(c.mode),
					common.text(i.ifname),
					radio,
					common.text(Array.isArray(c.network) ? c.network.join(' ') : c.network),
					up ? _('up') : _('down')
				]);
			});
		});
		return rows;
	},

	render: function(data) {
		var st = data[0];
		var setup = (st && st.setup) ? st.setup : null;
		var meshes = (st && st.mesh_interfaces) ? st.mesh_interfaces : {};
		var unsaved = common.unsavedConfig(st);
		var link = E('a', { 'href': L.url('admin/services/mesh11sd/status') }, _('Open Services > Mesh11sd'));

		if (!setup) {
			return E('div', {}, [ E('p', E('em', _('mesh11sd does not answer.'))), E('p', link) ]);
		}

		return E('div', {}, [
			this.pairs([
				[ _('Node type'), setup.node_type ? common.nodeTypeText(setup.node_type) : '-' ],
				[ _('Version'), common.text(setup.version) ],
				[ _('Auto config'), this.autoConfigText(setup) ],
				[ _('Not saved to flash'), unsaved.length ? unsaved.join(', ') : _('nothing') ]
			]),
			this.table([ _('Mesh interface'), _('Channel'), _('Mesh ID'), _('Active peers'), _('Active portal'), _('Portal ULA') ],
				Object.keys(meshes).sort().map(function(ifname) {
					var m = meshes[ifname] || {};

					return [ ifname, common.text(m.channel), common.text(m.mesh_id), common.text(m.active_peers),
						common.text(m.active_portal), common.text(m.portal_ula) ];
				}), _('No mesh interface is up.')),
			this.radioBoxes(data[1], data[2] || {}),
			this.table([ _('SSID / Mesh ID'), _('Mode'), _('Interface'), _('Radio'), _('Network'), _('State') ],
				this.wifiRows(data[1]), _('No wireless interfaces.')),
			E('p', link)
		]);
	}
});
