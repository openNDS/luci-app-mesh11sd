'use strict';
'require baseclass';
'require rpc';
'require fs';
'require dom';

/*
 * Shared code of the luci-app-mesh11sd views: the mesh11sd ubus calls and the version footer.
 * Not a page of its own (it is not in the menu); the views require it as view.mesh11sd.common.
 *
 * mesh11sd 8.x has the local ubus object "mesh11sd" (served by "mesh11sd ubus", a second procd
 * instance of the mesh11sd service). The views call it through rpcd (rpc.declare), allowed by
 * /usr/share/rpcd/acl.d/luci-app-mesh11sd.json. The only command run is "mesh11sd read_log",
 * on the Log page. The only ubus calls that change anything are config_reload,
 * auto_config_test and LuCI's standard system reboot call (Reboot node on Settings).
 */

/* luci-app-mesh11sd version: the only place to change at a version bump */
var version = '1.0.0beta';

var callStatus = rpc.declare({
	object: 'mesh11sd',
	method: 'status',
	expect: { '': {} }
});

var callStations = rpc.declare({
	object: 'mesh11sd',
	method: 'stations',
	expect: { 'interfaces': {} }
});

var callVersion = rpc.declare({
	object: 'mesh11sd',
	method: 'version',
	expect: { '': {} }
});

var callConfigReload = rpc.declare({
	object: 'mesh11sd',
	method: 'config_reload',
	reject: true
});

var callAutoConfigTest = rpc.declare({
	object: 'mesh11sd',
	method: 'auto_config_test',
	expect: { '': {} },
	reject: true
});

/* LuCI's standard reboot call, as used by System > Reboot */
var callReboot = rpc.declare({
	object: 'system',
	method: 'reboot',
	expect: { result: 0 }
});

/* the setup options that only take effect when mesh11sd starts, with their Settings titles */
var restartOptions = {
	'auto_config': _('Auto config'),
	'portal_detect': _('Portal detect'),
	'commit_all': _('Commit all'),
	'wpad_debuglevel': _('wpad debug level'),
	'odhcpd_log_level': _('odhcpd log level'),
	'mesh_backhaul_led': _('Mesh backhaul LED'),
	'mesh_multi_interfaces': _('Multiple mesh interfaces'),
	'swconfig_mac_skip': _('Skip swconfig MAC walk'),
	'cpe_mode': _('CPE mode'),
	'move_ethernet_to_vxlan_bridge': _('Ethernet on tunnel')
};

/* node_type in status */
var nodeTypes = {
	'MRP': _('Mesh routed portal'),
	'MPE': _('Mesh peer'),
	'CPE': _('Customer premises equipment'),
	'MBP': _('Mesh bridged portal'),
	'TPE': _('Trunk peer')
};

return baseclass.extend({
	version: version,

	/* "CPE (Customer premises equipment)", or the type as it is when unknown */
	nodeTypeText: function(t) {
		return nodeTypes[t] ? '%s (%s)'.format(t, nodeTypes[t]) : String(t);
	},

	/*
	 * The packages whose live configuration is not saved to flash (status unsaved_config,
	 * mesh11sd r76 or later), as an array; empty when everything is saved or unknown.
	 */
	unsavedConfig: function(st) {
		var v = (st && st.setup) ? st.setup.unsaved_config : null;

		return String(v || '').split(' ').filter(function(p) {
			return p != '';
		});
	},

	/* ubus call mesh11sd status, or null when mesh11sd does not answer */
	getStatus: function() {
		return L.resolveDefault(callStatus(), null).then(function(st) {
			if (st && st.setup) {
				return st;
			}
			return null;
		});
	},

	/* ubus call mesh11sd stations: { "<ifname>": [ { "mac": ..., "<iw field>": ... } ] } */
	getStations: function() {
		return L.resolveDefault(callStations(), {});
	},

	getVersion: function() {
		return L.resolveDefault(callVersion(), null);
	},

	/* ask the daemon to read its setup options again; rejects on failure */
	configReload: function() {
		return callConfigReload();
	},

	/* start the auto_config confidence test: { started: bool, message: why not } */
	autoConfigTest: function() {
		return callAutoConfigTest();
	},

	/* reboot the node */
	reboot: function() {
		return callReboot();
	},

	/* write live wireless/network/dhcp/firewall to flash (mesh11sd commit_all commit silent) */
	commitAll: function() {
		return fs.exec('/usr/libexec/mesh11sd-commit-all', []);
	},

	/* drop the committed config and reboot (mesh11sd revert_all revert, after the dialog) */
	revertAll: function() {
		return fs.exec('/usr/libexec/mesh11sd-revert-all', []);
	},

	/*
	 * Whether the flash wireless, network, dhcp or firewall config differs from the
	 * stock copies mesh11sd made before it first ran, or commit_all is 1: "modified"
	 * or "stock". Empty if the helper does not answer.
	 */
	savedState: function() {
		return fs.exec('/usr/libexec/mesh11sd-saved-state', []).then(function(res) {
			return String((res && res.stdout) || '').trim();
		}, function() {
			return '';
		});
	},

	/*
	 * Whether the saved setup has options that wait for a reboot (options mesh11sd reads only
	 * when it starts), from the status of a running daemon: null when not, else the titles of
	 * the changed options. A daemon that does not report its running values (started by
	 * mesh11sd before r72) counts as needing a reboot, with no titles. A reboot, not
	 * "service mesh11sd restart": the restart reverts staged network changes without
	 * reloading them, a reboot starts clean from the saved configuration.
	 */
	restartNeeded: function(st) {
		var setup = (st && st.setup) ? st.setup : null;
		var names;

		if (!setup || setup.procd_status != 'running') {
			return null;
		}
		if (setup.restart_needed == null) {
			return [];
		}
		if (String(setup.restart_needed) != '1') {
			return null;
		}
		names = String(setup.restart_options || '').split(' ').filter(function(n) {
			return n != '';
		});
		return names.map(function(n) {
			return restartOptions[n] || n;
		});
	},

	/* a value as display text, '-' when empty */
	text: function(v) {
		if (v == null || v === '') {
			return '-';
		}
		return String(v);
	},

	/* the footer text for a version reply (undefined while unknown) */
	footerText: function(v) {
		var t = _('luci-app-mesh11sd %s').format(version);
		var m;

		if (v === undefined) {
			return t;
		}

		m = _('unknown');
		if (v && v.version) {
			m = v.version;
			if (v.build_commit && v.build_commit != 'unknown') {
				m = m + ' (' + v.build_commit + ')';
			}
		}

		return '%s, %s'.format(t, _('mesh11sd %s').format(m));
	},

	/* a small line for the bottom of a page; the mesh11sd version is filled in when it arrives */
	footer: function() {
		var self = this;
		var node = E('div', {
			'class': 'mesh11sd-version',
			'style': 'text-align:right; font-size:smaller; opacity:0.7; margin-top:1em'
		}, [ this.footerText() ]);

		this.getVersion().then(function(v) {
			dom.content(node, [ self.footerText(v) ]);
		});

		return node;
	}
});
