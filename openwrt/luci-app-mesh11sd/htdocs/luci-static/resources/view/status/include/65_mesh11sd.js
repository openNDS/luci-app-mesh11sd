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
 * No keys are shown.
 */

var callWirelessDevices = rpc.declare({
	object: 'luci-rpc',
	method: 'getWirelessDevices',
	expect: { '': {} }
});

return baseclass.extend({
	title: _('Mesh11sd'),

	load: function() {
		return Promise.all([
			common.getStatus(),
			L.resolveDefault(callWirelessDevices(), {})
		]);
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
			this.table([ _('SSID / Mesh ID'), _('Mode'), _('Interface'), _('Radio'), _('Network'), _('State') ],
				this.wifiRows(data[1]), _('No wireless interfaces.')),
			E('p', link)
		]);
	}
});
