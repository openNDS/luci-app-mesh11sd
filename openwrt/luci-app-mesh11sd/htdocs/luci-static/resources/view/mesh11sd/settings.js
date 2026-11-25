'use strict';
'require view';
'require form';
'require uci';
'require ui';
'require rpc';
'require view.mesh11sd.common as common';

/*
 * mesh11sd settings: the "config mesh11sd 'setup'" section of /etc/config/mesh11sd.
 * Every option is optional and has a built-in default in mesh11sd, so defaults are shown as
 * placeholders and an option is only written when it is changed. The mesh_params section is
 * not edited here.
 *
 * Save & Apply commits the mesh11sd config only. The init script's reload trigger then runs
 * "service mesh11sd reload" (mesh11sd config_reload): the daemon reads its settings again at
 * the start of its next loop, without a restart. Each option says when a change takes effect,
 * as in "Applying changes" in the mesh11sd README:
 *   live    - applied by the reload
 *   build   - used when the wireless and network configuration is built
 *   restart - read only when mesh11sd starts, so applied by a reboot; the Reboot node action
 *             is shown while such a saved option differs from the running daemon's (status
 *             restart_needed)
 *   cli     - read by the mesh11sd command line each time it runs
 * Keys are password fields. Nothing here reads or shows a key that is not in the config.
 */

/* the driver's country list, as LuCI's wireless page reads it */
var callCountryList = rpc.declare({
	object: 'iwinfo',
	method: 'countrylist',
	params: [ 'device' ],
	expect: { results: [] }
});

/*
 * Country: a list of the driver's countries (iwinfo countrylist for the radio in .device),
 * with "Default (DFS-ETSI)" first, which leaves the option unset. A saved value that is not
 * in the list is still offered. Without a list (no wireless, or no access), a text field.
 */
var CountryValue = form.Value.extend({
	load: function(section_id) {
		return L.resolveDefault(callCountryList(this.device), []).then(L.bind(function(list) {
			var cur = uci.get('mesh11sd', section_id, 'country');

			if (Array.isArray(list) && list.length) {
				this.value('', _('Default (DFS-ETSI)'));
				list.forEach(L.bind(function(c) {
					this.value(c.iso3166, '%s - %s'.format(c.iso3166, c.country));
				}, this));
				if (cur && this.keylist.indexOf(cur) < 0) {
					this.value(cur, cur);
				}
			}
			return form.Value.prototype.load.apply(this, [ section_id ]);
		}, this));
	},

	validate: function(section_id, value) {
		if (value == null || value === '' || (this.keylist && this.keylist.indexOf(value) >= 0) ||
		    /^[A-Z0-9][A-Z0-9]$/.test(value)) {
			return true;
		}
		return _('Use ISO/IEC 3166 alpha2 country codes.');
	},

	renderWidget: function(section_id, option_index, cfgvalue) {
		var cls = (this.keylist && this.keylist.length) ? form.ListValue : form.Value;

		return cls.prototype.renderWidget.apply(this, [ section_id, option_index, cfgvalue ]);
	}
});

var WHEN = {
	'live': _('Applied on Save & Apply.'),
	'build': _('Used when the wireless and network configuration is built, normally at first configuration.'),
	'restart': _('Takes effect after a reboot: after Save & Apply, use Reboot node at the top of this page.'),
	'cli': _('Used by the mesh11sd command line.')
};

return view.extend({
	load: function() {
		return Promise.all([ uci.load('mesh11sd'), common.getStatus(), common.savedState() ]);
	},

	/*
	 * How this node uses the tunnel address, from its node type in the status:
	 * 'static' on a routed portal (MRP) or a trunk bridged portal (MBP), 'dhcp' on a trunk
	 * peer (TPE), 'none' on a peer or CPE, which bridge the tunnel without an address, and
	 * null while unknown.
	 */
	tunnelAddressing: function(st) {
		var type = (st && st.setup) ? st.setup.node_type : null;

		if (type == 'MRP' || type == 'MBP') {
			return 'static';
		}
		if (type == 'TPE') {
			return 'dhcp';
		}
		if (type == 'MPE' || type == 'CPE') {
			return 'none';
		}
		return null;
	},

	/* placeholder of a tunnel address option: its default where it is used, else why it is empty */
	tunnelPlaceholder: function(tunnel, dflt) {
		if (tunnel == 'none') {
			return _('not set on this node');
		}
		if (tunnel == 'dhcp') {
			return _('set by DHCP on this node');
		}
		return dflt;
	},

	/*
	 * The auto_config confidence test ("mesh11sd auto_config test"): a button while the
	 * running daemon has auto_config 0 (status running_auto_config; setup.auto_config is the
	 * saved value), nothing waits for a reboot and no test is running, otherwise a note.
	 */
	confidenceTest: function(s, st, reboot) {
		var setup = (st && st.setup) ? st.setup : null;
		var running = (setup && setup.running_auto_config != null) ? String(setup.running_auto_config) : null;
		var self = this;
		var o;

		if (setup && String(setup.auto_config) == '0' && running == '0' && !reboot &&
		    String(setup.auto_config_test) != '1') {
			o = s.taboption('general', form.Button, '_auto_config_test', _('Confidence test'),
				_('Try the automatic configuration without saving it.'));
			o.inputtitle = _('Run confidence test');
			o.inputstyle = 'action';
			o.onclick = function() {
				self.confirmConfidenceTest();
			};
			return;
		}

		o = s.taboption('general', form.DummyValue, '_auto_config_test', _('Confidence test'));
		if (!setup) {
			o.default = _('Not available: mesh11sd does not answer.');
		}
		else if (String(setup.auto_config_test) == '1') {
			o.default = _('The confidence test is running. A reboot undoes it. If the node works as expected, set Auto config to 1 to keep the configuration.');
		}
		else if (String(setup.auto_config) == '0' && setup.procd_status != 'running') {
			o.default = _('Not available: mesh11sd is not running.');
		}
		else if (String(setup.auto_config) == '0' && reboot) {
			o.default = _('Reboot the node first: the running mesh11sd does not have the saved settings yet.');
		}
		else {
			o.default = _('Auto config is on, so there is nothing to test.');
		}
	},

	/* the Reboot node button */
	rebootButton: function() {
		return E('button', {
			'class': 'btn cbi-button-action',
			'click': ui.createHandlerFn(this, 'confirmReboot')
		}, _('Reboot node'));
	},

	/* the notice at the top of the page while saved options wait for a reboot */
	rebootNotice: function(changed) {
		var msg = changed.length
			? _('Saved settings take effect after a reboot: %s.').format(changed.join(', '))
			: _('The running mesh11sd may not have all the saved settings. Reboot the node to apply them.');

		return E('div', { 'class': 'alert-message warning' }, [
			E('p', msg),
			E('p', this.rebootButton())
		]);
	},

	confirmReboot: function() {
		var self = this;

		ui.showModal(_('Reboot node?'), [
			E('p', _('The node reboots and comes up with its saved settings. This may change its role and addresses, so this page will stop responding.')),
			E('p', _('Reconnect to LuCI at the node\'s address. If the address has changed, find it with SSH over IPv6 link-local (see "Accessing a node" in the mesh11sd README).')),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
				' ',
				E('button', {
					'class': 'btn cbi-button-action',
					'click': ui.createHandlerFn(this, function() {
						return self.runReboot();
					})
				}, _('Reboot'))
			])
		]);
	},

	runReboot: function() {
		return common.reboot().then(function(res) {
			if (res != 0) {
				ui.hideModal();
				ui.addNotification(null, E('p', _('Could not reboot: %s').format(rpc.getStatusText(res))), 'error');
				return;
			}
			ui.showModal(_('Rebooting'), [
				E('p', _('The node is rebooting. Reconnect to LuCI at the node\'s address when it is back. If the address has changed, find it with SSH over IPv6 link-local.')),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close'))
				])
			]);
		}, function(e) {
			ui.hideModal();
			ui.addNotification(null, E('p', _('Could not reboot: %s').format(e)), 'error');
		});
	},

	confirmConfidenceTest: function() {
		var self = this;

		ui.showModal(_('Run the confidence test?'), [
			E('p', _('The test applies the automatic configuration to this node now. Its network and wireless settings change, and so does its IPv4 address, so this page will stop responding.')),
			E('p', _('Reconnect to LuCI at the node\'s new IPv4 address. To find it, use SSH over IPv6 link-local (see "Accessing a node" in the mesh11sd README).')),
			E('p', _('The changes are not saved, so a reboot undoes the test. If the node works as expected, set Auto config to 1 to keep the configuration.')),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
				' ',
				E('button', {
					'class': 'btn cbi-button-action',
					'click': ui.createHandlerFn(this, function() {
						return self.runConfidenceTest();
					})
				}, _('Run test'))
			])
		]);
	},

	runConfidenceTest: function() {
		return common.autoConfigTest().then(function(res) {
			if (!res || !res.started) {
				ui.hideModal();
				ui.addNotification(null, E('p', (res && res.message) ? res.message : _('The confidence test was not started.')), 'warning');
				return;
			}
			ui.showModal(_('Confidence test started'), [
				E('p', _('This node is applying the automatic configuration. The connection to this page is expected to drop as its address changes. Reconnect to LuCI at the new IPv4 address; to find it, use SSH over IPv6 link-local.')),
				E('p', _('A reboot undoes the test. If the node works as expected, set Auto config to 1 to keep the configuration.')),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close'))
				])
			]);
		}, function(e) {
			ui.hideModal();
			ui.addNotification(null, E('p', _('Could not start the confidence test: %s').format(e)), 'error');
		});
	},

	/*
	 * Save live config / Revert saved config. Hidden while auto_config is 0
	 * (the mesh11sd CLI refuses both commands, and mesh11sd is not managing
	 * the config). Revert is shown when the flash wireless, network, dhcp or
	 * firewall config differs from mesh11sd's stock copies, or commit_all is
	 * 1. Save is shown when the flash config still matches those copies.
	 * If the helper does not answer, the saved commit_all flag is used, as in r9.
	 */
	commitAllButtons: function(s, st, saved) {
		var setup = (st && st.setup) ? st.setup : null;
		var auto = uci.get('mesh11sd', 'setup', 'auto_config');
		var committed = uci.get('mesh11sd', 'setup', 'commit_all');
		var self = this;
		var o;

		if (auto == null && setup && setup.auto_config != null) {
			auto = setup.auto_config;
		}
		auto = (auto != null) ? String(auto) : '0';
		committed = (committed != null) ? String(committed) : '0';
		saved = (saved != null) ? String(saved) : '';
		if (saved != 'modified' && saved != 'stock') {
			saved = (committed == '1') ? 'modified' : 'stock';
		}

		if (auto == '0') {
			return;
		}

		if (saved == 'modified') {
			o = s.taboption('general', form.Button, '_revert_all', _('Revert saved config'),
				_('Drop the configuration previously saved to flash and return to dynamic auto configuration. The node reboots.'));
			o.inputtitle = _('Revert saved config');
			o.inputstyle = 'negative';
			o.onclick = function() {
				self.confirmRevertAll();
			};
		}

		if (saved == 'stock') {
			o = s.taboption('general', form.Button, '_commit_all', _('Save live config to flash'),
				_('Write the live wireless, network, dhcp and firewall configuration to flash and keep the current role. A reboot is required.'));
			o.inputtitle = _('Save live config to flash');
			o.inputstyle = 'action';
			o.onclick = function() {
				self.confirmCommitAll();
			};
		}
	},

	execMessage: function(res, fallback) {
		var t = '';

		if (res) {
			t = String(res.stderr || '').trim() || String(res.stdout || '').trim();
		}
		return t || fallback;
	},

	confirmCommitAll: function() {
		var self = this;

		ui.showModal(_('Save live config to flash?'), [
			E('p', _('This writes the live wireless, network, dhcp and firewall configuration to flash.')),
			E('p', _('After a reboot, this node keeps its current role. Portal detection will no longer switch the role automatically. To change role later, use Revert saved config first.')),
			E('p', _('The wan port is left as a normal wan interface, not joined to the lan bridge. If you later plug an upstream router into wan, the portal check can still see it and this node will try to become a portal, and will start serving addresses on the lan.')),
			E('p', _('A reboot is required for this to take effect.')),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
				' ',
				E('button', {
					'class': 'btn cbi-button-action',
					'click': ui.createHandlerFn(this, function() {
						return self.runCommitAll();
					})
				}, _('Save to flash'))
			])
		]);
	},

	runCommitAll: function() {
		var self = this;

		return common.commitAll().then(function(res) {
			if (!res || res.code != 0) {
				ui.hideModal();
				ui.addNotification(null, E('p', self.execMessage(res, _('Could not save the live config.'))), 'error');
				return;
			}
			ui.showModal(_('Live config saved'), [
				E('p', _('The live configuration is now on flash. Reboot the node for this to take effect. Until then, portal detection may still change the role.')),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close')),
					' ',
					E('button', {
						'class': 'btn cbi-button-action',
						'click': ui.createHandlerFn(self, 'confirmReboot')
					}, _('Reboot node'))
				])
			]);
		}, function(e) {
			ui.hideModal();
			ui.addNotification(null, E('p', _('Could not save the live config: %s').format(e)), 'error');
		});
	},

	confirmRevertAll: function() {
		var self = this;

		ui.showModal(_('Revert saved config?'), [
			E('p', _('This drops the configuration previously saved to flash and returns to dynamic auto configuration.')),
			E('p', _('The node will reboot, and this page will stop responding. Reconnect to LuCI at the node\'s address when it is back. If the address has changed, find it with SSH over IPv6 link-local (see "Accessing a node" in the mesh11sd README).')),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
				' ',
				E('button', {
					'class': 'btn cbi-button-negative',
					'click': ui.createHandlerFn(this, function() {
						return self.runRevertAll();
					})
				}, _('Revert and reboot'))
			])
		]);
	},

	runRevertAll: function() {
		var self = this;

		return common.revertAll().then(function(res) {
			if (!res || res.code != 0) {
				ui.hideModal();
				ui.addNotification(null, E('p', self.execMessage(res, _('Could not revert the saved config.'))), 'error');
				return;
			}
			ui.showModal(_('Rebooting'), [
				E('p', _('The saved configuration has been dropped. The node is rebooting into dynamic auto configuration. Reconnect to LuCI at the node\'s address when it is back. If the address has changed, find it with SSH over IPv6 link-local.')),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close'))
				])
			]);
		}, function() {
			/* the node reboots as soon as revert_all finishes, so a dropped connection is expected */
			ui.showModal(_('Rebooting'), [
				E('p', _('The node is rebooting into dynamic auto configuration. Reconnect to LuCI at the node\'s address when it is back. If the address has changed, find it with SSH over IPv6 link-local.')),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close'))
				])
			]);
		});
	},

	/* the radio to read the country list from: the mesh radio, else radio0 */

	countryDevice: function(st) {
		var m = (st && st.mesh_interfaces) ? st.mesh_interfaces : {};
		var ifs = Object.keys(m);

		return (ifs.length && m[ifs[0]].device) ? m[ifs[0]].device : 'radio0';
	},

	/* add the "when does it apply" note to an option's description */
	when: function(o, kind) {
		o.description = o.description ? '%s %s'.format(o.description, WHEN[kind]) : WHEN[kind];
		return o;
	},

	/*
	 * ListValue that never writes its default to an unset option: picking the default
	 * leaves the option unset, or removes it if it was set.
	 */
	listDefault: function(o, dflt) {
		o.default = dflt;
		o.write = function(section_id, value) {
			if (value === dflt) {
				if (this.cfgvalue(section_id) != null) {
					return this.remove(section_id);
				}
				return;
			}
			return form.ListValue.prototype.write.apply(this, [ section_id, value ]);
		};
		return o;
	},

	/* a ListValue with [ value, title ] choices and a default that is not written */
	list: function(s, tab, name, title, descr, choices, dflt, kind) {
		var o = s.taboption(tab, form.ListValue, name, title, descr);

		choices.forEach(function(c) {
			o.value(c[0], c[1]);
		});
		this.listDefault(o, dflt);
		return this.when(o, kind);
	},

	/* an on/off ListValue (0 or 1) whose default is not written */
	flag: function(s, tab, name, title, descr, dflt, kind) {
		return this.list(s, tab, name, title, descr,
			[ [ '1', _('Enabled') ], [ '0', _('Disabled') ] ], dflt, kind);
	},

	/* a Value for a whole number between min and max, with the default as placeholder */
	intValue: function(s, tab, name, title, descr, dflt, min, max, kind) {
		var o = s.taboption(tab, form.Value, name, title, descr);

		o.datatype = 'range(%d,%d)'.format(min, max);
		o.placeholder = dflt;
		o.rmempty = true;
		return this.when(o, kind);
	},

	/* a text Value with a placeholder */
	textValue: function(s, tab, name, title, descr, placeholder, kind) {
		var o = s.taboption(tab, form.Value, name, title, descr);

		o.placeholder = placeholder;
		o.rmempty = true;
		return this.when(o, kind);
	},

	/* a key: a password field, never shown in clear unless the user asks */
	keyValue: function(s, tab, name, title, descr, kind) {
		var o = s.taboption(tab, form.Value, name, title, descr);

		o.password = true;
		o.rmempty = true;
		return this.when(o, kind);
	},

	/* an absolute path, or empty */
	validatePath: function(section_id, value) {
		if (value === '' || /^\/[^ ]*$/.test(value)) {
			return true;
		}
		return _('Must be an absolute path');
	},

	render: function(data) {
		var st = data[1];
		var saved = data[2];
		var reboot = common.restartNeeded(st);
		var self = this;
		var tunnel = this.tunnelAddressing(st);
		var derived = (st && st.setup) ? st.setup.vtun_ip : null;
		var encryption = [
			[ '0', _('0 - none (OWE transition)') ],
			[ '1', _('1 - SAE (WPA3)') ],
			[ '2', _('2 - SAE mixed (WPA2/WPA3)') ],
			[ '3', _('3 - PSK2 (WPA2)') ],
			[ '4', _('4 - OWE') ]
		];
		var m;
		var s;
		var o;

		m = new form.Map('mesh11sd', _('Mesh11sd'),
			_('Settings of mesh11sd on this node. Save & Apply asks the running daemon to read its settings again, without a restart; each option says when a change takes effect. With auto config 1 and portal detect 0 or 1, a saved change also rebuilds the portal configuration.'));

		s = m.section(form.NamedSection, 'setup', 'mesh11sd', _('Settings'));
		s.anonymous = true;
		s.addremove = false;

		s.tab('general', _('General'));
		s.tab('mesh', _('Mesh backhaul'));
		s.tab('gate', _('Gate and SSID'));
		s.tab('advanced', _('Advanced'));

		/* General */

		this.flag(s, 'general', 'enabled', _('Enabled'),
			_('Run the mesh11sd daemon.'), '1', 'live');

		this.list(s, 'general', 'auto_config', _('Auto config'),
			_('0 off; 1 on, the portal configuration is committed and LuCI can be used; 2 on, everything is committed and the first role is kept.'),
			[ [ '0', _('0 - off') ], [ '1', _('1 - on') ], [ '2', _('2 - on, commit all') ] ], '0', 'restart');

		this.commitAllButtons(s, st, saved);

		if (reboot) {
			o = s.taboption('general', form.Button, '_reboot', _('Reboot node'),
				_('Saved settings take effect after a reboot.'));
			o.inputtitle = _('Reboot node');
			o.inputstyle = 'action';
			o.onclick = function() {
				self.confirmReboot();
			};
		}

		this.confidenceTest(s, st, reboot);

		this.list(s, 'general', 'portal_detect', _('Portal detect'),
			_('The node type. Ignored while auto config is off.'),
			[ [ '1', _('1 - auto: portal with a wan link, otherwise peer') ],
			  [ '0', _('0 - always a routed portal (MRP)') ],
			  [ '3', _('3 - customer premises equipment (CPE)') ],
			  [ '4', _('4 - bridged portal (MBP)') ],
			  [ '5', _('5 - trunk peer (TPE)') ] ], '1', 'restart');

		o = this.list(s, 'general', 'cpe_mode', _('CPE mode'),
			_('CPE only: how the LAN gets its IPv6 addresses.'),
			[ [ 'nat66', _('NAT66') ], [ 'pd', _('Prefix delegation') ] ], 'nat66', 'restart');
		o.depends('portal_detect', '3');
		/* mesh11sd reads prefix_delegation as pd: show a saved one as pd, and leave it as it is */
		o.cfgvalue = function(section_id) {
			var v = form.ListValue.prototype.cfgvalue.apply(this, [ section_id ]);

			return (v == 'prefix_delegation') ? 'pd' : v;
		};

		o = s.taboption('general', CountryValue, 'country', _('Country'),
			_('Wireless country code, overriding the wireless config. Default DFS-ETSI.'));
		o.device = this.countryDevice(st);
		o.placeholder = 'DFS-ETSI';
		o.rmempty = true;
		this.when(o, 'build');

		this.list(s, 'general', 'debuglevel', _('Debug level'),
			_('Notices, warnings and errors also go to the system log; info and debug go to the mesh11sd log only.'),
			[ [ '0', _('0 - silent') ], [ '1', _('1 - notice') ], [ '2', _('2 - info') ], [ '3', _('3 - debug') ] ], '3', 'live');

		this.intValue(s, 'general', 'checkinterval', _('Check interval'),
			_('Seconds between configuration checks. Default 10.'), '10', 1, 3600, 'live');

		this.flag(s, 'general', 'manage_opennds_startup', _('Manage openNDS'),
			_('If openNDS is installed: start it on a portal or CPE, stop it on a peer.'), '1', 'live');

		o = this.textValue(s, 'general', 'log_mountpoint', _('Log mountpoint'),
			_('Where the mesh11sd log is kept, in its mesh11sd directory, for example /mnt/usb. Not on system flash. Default /tmp.'), '/tmp', 'live');
		o.validate = this.validatePath;

		this.intValue(s, 'general', 'max_log_entries', _('Maximum log entries'),
			_('Lines kept in the mesh11sd log. Default 500.'), '500', 10, 100000, 'live');

		/* Mesh backhaul */

		this.textValue(s, 'mesh', 'auto_mesh_id', _('Mesh ID seed'),
			_('Hashed to the mesh ID. The same on every node. Default --__, the built-in seed.'), '--__', 'build');

		this.keyValue(s, 'mesh', 'auto_mesh_key', _('Mesh key seed'),
			_('Extra seed for the mesh SAE key. If set, the same on every node.'), 'build');

		this.list(s, 'mesh', 'auto_mesh_band', _('Mesh band'), null,
			[ [ '2g', _('2.4 GHz') ], [ '5g', _('5 GHz') ], [ '6g', _('6 GHz') ], [ '60g', _('60 GHz') ] ], '2g', 'build');

		this.list(s, 'mesh', 'channel_bandwidth_2g', _('2.4 GHz channel width'), null,
			[ [ '20', _('20 MHz') ], [ '40', _('40 MHz') ] ], '40', 'build');

		o = this.textValue(s, 'mesh', 'portal_channel', _('Portal channel'),
			_('Portal, 2.4 GHz only: auto, default (the channel in the wireless config) or a channel number. Peers follow the portal.'), 'default', 'build');
		o.value('auto', _('auto'));
		o.value('default', _('default'));
		o.validate = function(section_id, value) {
			if (value === '' || value === 'auto' || value === 'default' || /^([1-9]|1[0-3])$/.test(value)) {
				return true;
			}
			return _('auto, default or a channel from 1 to 13');
		};

		this.textValue(s, 'mesh', 'mesh_phy_index', _('Mesh radio index'),
			_('Forces the mesh onto phyN. Normally empty: mesh11sd picks the radio.'), _('auto'), 'build').datatype = 'uinteger';

		this.list(s, 'mesh', 'mesh_multi_interfaces', _('Multiple mesh interfaces'),
			_('Allow more than one mesh interface.'),
			[ [ 'disabled', _('Disabled') ], [ 'enabled', _('Enabled') ] ], 'disabled', 'restart');

		this.textValue(s, 'mesh', 'mesh_basename', _('Mesh interface base name'),
			_('Up to 4 letters or digits; the interface is m-<name>-0. Default 11s.'), '11s', 'build');

		this.textValue(s, 'mesh', 'auto_mesh_network', _('Mesh network'),
			_('The network (and firewall zone) of the mesh. Not wan. Default lan.'), 'lan', 'build');

		this.intValue(s, 'mesh', 'txpower', _('Transmit power'),
			_('dBm, within the regulatory limit. Empty leaves the driver setting.'), _('driver default'), 1, 100, 'live');

		this.intValue(s, 'mesh', 'mesh_path_cost', _('Mesh path cost'),
			_('STP cost of the mesh. 0 does not set it. Default 65525.'), '65525', 0, 65535, 'live');

		this.flag(s, 'mesh', 'disable_hwmp_forwarding', _('No forwarding'),
			_('Peers only: serve this node\'s own access points but do not forward for other nodes.'), '0', 'live');

		this.list(s, 'mesh', 'mesh_node_mobility_level', _('Node mobility level'),
			_('0 for fixed nodes, up to 6 for nodes that move.'),
			[ [ '0', '0' ], [ '1', '1' ], [ '2', '2' ], [ '3', '3' ], [ '4', '4' ], [ '5', '5' ], [ '6', '6' ] ], '2', 'live');

		this.intValue(s, 'mesh', 'mesh_metric_threshold', _('Portal metric threshold'),
			_('A portal must be better than the current one by this airtime metric to be chosen. Default 50.'), '50', 0, 65535, 'live');

		/* Gate and SSID */

		this.list(s, 'gate', 'mesh_gate_enable', _('Access points'),
			null,
			[ [ '1', _('1 - all on') ], [ '0', _('0 - all off') ], [ '2', _('2 - only on radios without a mesh interface') ] ], '1', 'build');

		this.textValue(s, 'gate', 'mesh_gate_base_ssid', _('SSID'),
			_('Up to 22 characters with the suffix, 30 without. Spaces are removed. Default MeshGate.'), 'MeshGate', 'build');

		this.flag(s, 'gate', 'keep_system_ssids', _('Keep system SSIDs'),
			_('While SSID is empty, keep the SSIDs of the wireless config. A stock OpenWrt SSID is always replaced.'), '0', 'build');

		this.flag(s, 'gate', 'ssid_suffix_enable', _('SSID suffix'),
			_('Append the last 4 hex digits of the mesh MAC address to the SSID.'), '1', 'build');

		this.list(s, 'gate', 'mesh_gate_encryption', _('Encryption'),
			_('0 and 4 need a full wpad.'), encryption, '4', 'build');

		o = this.keyValue(s, 'gate', 'mesh_gate_key', _('Key'),
			_('For encryption 1, 2 and 3.'), 'build');
		o.depends('mesh_gate_encryption', '1');
		o.depends('mesh_gate_encryption', '2');
		o.depends('mesh_gate_encryption', '3');

		this.flag(s, 'gate', 'vtun_enable', _('VXLAN tunnel'),
			_('A point to multipoint vxlan tunnel with its own SSID, for example for guests. Needs ip-full and vxlan.'), '1', 'build');

		this.intValue(s, 'gate', 'tun_id', _('Tunnel ID'),
			_('The VNI; the bridge is br-tun<ID>. Default 69.'), '69', 1, 16777216, 'build');

		/* the tunnel address is only set on a portal or a trunk bridged portal */
		o = this.textValue(s, 'gate', 'vtun_ip', _('Tunnel IPv4 address'),
			_('Portal and MBP only. Empty: use the address derived from the mesh key.'),
			this.tunnelPlaceholder(tunnel, /^\d+\.\d+\.\d+\.\d+$/.test(derived || '')
				? _('derived: %s').format(derived) : _('derived from the mesh key')), 'build');
		o.datatype = 'ip4addr("nomask")';

		this.textValue(s, 'gate', 'vtun_mask', _('Tunnel netmask'),
			_('A dotted netmask or prefix length, default 255.255.255.0. Used only on a portal or a trunk bridged portal (MBP); peers and CPEs bridge the tunnel without an address.'),
			this.tunnelPlaceholder(tunnel, '255.255.255.0'), 'build');

		this.textValue(s, 'gate', 'vtun_base_ssid', _('Tunnel SSID'),
			_('Spaces are removed. Default VTunnel.'), 'VTunnel', 'build');

		this.list(s, 'gate', 'vtun_gate_encryption', _('Tunnel encryption'), null, encryption, '4', 'build');

		o = this.keyValue(s, 'gate', 'vtun_gate_key', _('Tunnel key'),
			_('For encryption 1, 2 and 3; at least 8 characters.'), 'build');
		o.datatype = 'minlength(8)';
		o.depends('vtun_gate_encryption', '1');
		o.depends('vtun_gate_encryption', '2');
		o.depends('vtun_gate_encryption', '3');

		this.intValue(s, 'gate', 'vtun_path_cost', _('Tunnel path cost'),
			_('STP cost of the tunnel. 0 does not set it. Default 65525.'), '65525', 0, 65535, 'build');

		this.flag(s, 'gate', 'vtun_isolate', _('Isolate tunnel'),
			_('No forwarding between the mesh or lan and the tunnel.'), '0', 'build');

		this.flag(s, 'gate', 'move_ethernet_to_vxlan_bridge', _('Ethernet on tunnel'),
			_('Move the lan ethernet ports onto the tunnel bridge. Not used on CPE.'), '0', 'restart');

		/* Advanced */

		this.intValue(s, 'advanced', 'loop_interval_delta', _('Loop interval delta'),
			_('Seconds added to the check interval as a progressive step, when the node is under high load: one step from a load of 0.5 per CPU, two from 1.0. 0 turns it off. Default 20.'), '20', 0, 3600, 'live');

		this.intValue(s, 'advanced', 'channel_tracking_checkinterval', _('Channel tracking interval'),
			_('Minimum seconds between peer channel scans. Default 8/3 of the check interval.'), _('8/3 of the check interval'), 1, 86400, 'live');

		this.intValue(s, 'advanced', 'portal_detect_threshold', _('Portal detect threshold'),
			_('Peers and CPEs: check intervals without a portal before the watchdog acts. It then restarts the network and, if the portal is still missing, reboots or stops as set in Reboot on error or Stop on error below. 0 turns the watchdog off. Default 5.'), '5', 0, 1000, 'live');

		this.intValue(s, 'advanced', 'interface_timeout', _('Interface timeout'),
			_('Seconds to wait for an interface to come up. Default 10.'), '10', 1, 300, 'live');

		this.flag(s, 'advanced', 'portal_use_default_ipv4', _('Portal keeps its IPv4 address'),
			_('Keep the IPv4 address in the network config instead of one derived from the mesh ID (on a CPE, from its label MAC).'), '0', 'build');

		this.flag(s, 'advanced', 'mesh_mac_forced_forwarding', _('MAC forced forwarding'),
			_('Sets proxy_arp_pvlan on the mesh interface.'), '1', 'live');

		this.flag(s, 'advanced', 'gateway_proxy_arp', _('Gateway proxy ARP'),
			_('Sets proxy_arp on the bridge.'), '1', 'live');

		this.flag(s, 'advanced', 'swconfig_mac_skip', _('Skip swconfig MAC walk'),
			_('Leave swconfig bridge and port MAC addresses unchanged. No effect with DSA.'), '0', 'restart');

		this.flag(s, 'advanced', 'reboot_on_error', _('Reboot on error'),
			_('The watchdog reboots the node if the portal is still missing.'), '1', 'live');

		this.flag(s, 'advanced', 'stop_on_error', _('Stop on error'),
			_('Stop managing the mesh instead of rebooting. Overrides reboot on error.'), '0', 'live');

		this.flag(s, 'advanced', 'watchdog_nonvolatile_log', _('Watchdog log on flash'),
			_('Debugging only: writes /mesh11sd_log/mesh11sd.log on flash, which wears it.'), '0', 'live');

		this.textValue(s, 'advanced', 'mesh_backhaul_led', _('Mesh backhaul LED'),
			_('auto, none, or an LED name from /sys/class/leds (color:function).'), 'auto', 'restart');

		this.flag(s, 'advanced', 'use_default_beacon_interval', _('Default beacon interval'),
			_('Leave the beacon interval at the driver default. Off sets it from the mobility level, except on drivers that need 100 ms.'), '1', 'build');

		this.intValue(s, 'advanced', 'mesh_dtim_period', _('DTIM period'),
			_('Overridden by the mobility level unless the driver ignores it. Default 2.'), '2', 1, 255, 'build');

		this.list(s, 'advanced', 'odhcpd_log_level', _('odhcpd log level'), null,
			[ [ '0', '0' ], [ '1', '1' ], [ '2', '2' ], [ '3', '3' ], [ '4', '4' ], [ '5', '5' ], [ '6', '6' ], [ '7', '7' ] ], '3', 'restart');

		this.list(s, 'advanced', 'wpad_debuglevel', _('wpad debug level'),
			_('0 to 2 quiet, 3 info, 4 and 5 debug.'),
			[ [ '0', '0' ], [ '1', '1' ], [ '2', '2' ], [ '3', '3' ], [ '4', '4' ], [ '5', '5' ] ], '2', 'restart');

		this.flag(s, 'advanced', 'connect_show_all', _('Connect lists all nodes'),
			_('"mesh11sd connect" without a node ID also lists island meshes.'), '1', 'cli');

		return m.render().then(function(node) {
			return E('div', {}, [ reboot ? self.rebootNotice(reboot) : '', node, common.footer() ]);
		});
	}
});
