'use strict';
'require view';
'require poll';
'require dom';
'require ui';
'require view.mesh11sd.common as common';

/*
 * mesh11sd status: "ubus call mesh11sd status" (the same JSON as "mesh11sd status") and
 * "ubus call mesh11sd stations" (iw station dump of each mesh interface), refreshed every
 * 10 seconds. Neither reply carries a key or passphrase.
 *
 * status:   { "setup": { ... }, "mesh_interfaces": { "<ifname>": { ..., "peers": { "<mac>":
 *           { next_hop, hop_count, airtime_metric, ... } }, "stations": { "<mac>":
 *           { proxy_node } } } }, "layer2_connections": { ... } }
 * stations: { "<ifname>": [ { "mac": ..., "mesh plink": ..., "signal": ..., ... } ] }
 */

var DEBUGLEVEL = {
	'0': _('silent'),
	'1': _('notice'),
	'2': _('info'),
	'3': _('debug')
};

/* the setup fields shown first, in this order; the rest follow under "All setup values" */
var SUMMARY = [
	[ 'version', _('Version') ],
	[ 'procd_status', _('Service') ],
	[ 'node_type', _('Node type') ],
	[ 'label_mac', _('Label MAC') ],
	[ 'enabled', _('Enabled') ],
	[ 'auto_config', _('Auto config') ],
	[ 'portal_detect', _('Portal detect') ],
	[ 'mesh_gate_enable', _('Mesh gate (access points)') ],
	[ 'auto_mesh_band', _('Mesh band') ],
	[ 'mesh_driver', _('Wireless driver') ],
	[ 'txpower', _('Transmit power') ],
	[ 'loop_interval', _('Current loop interval') ],
	[ 'debuglevel', _('Debug level') ]
];

/* fields of one mesh interface shown in its summary, in this order */
var IFACE = [
	[ 'mesh_id', _('Mesh ID') ],
	[ 'device', _('Radio') ],
	[ 'channel', _('Channel') ],
	[ 'this_node', _('This node') ],
	[ 'active_portal', _('Active portal') ],
	[ 'portal_ula', _('Portal address') ],
	[ 'active_peers', _('Mesh paths') ],
	[ 'active_stations', _('Stations') ],
	[ 'mesh_fwding', _('Forwarding') ],
	[ 'mesh_hwmp_rootmode', _('HWMP root mode') ],
	[ 'mesh_rssi_threshold', _('RSSI threshold') ],
	[ 'mesh_plink_timeout', _('Peer link timeout') ],
	[ 'tx_bytes', _('Transmitted bytes') ],
	[ 'rx_bytes', _('Received bytes') ]
];

/* one-hop peer columns from the stations reply: [ iw field, title ] */
var PEER_COLUMNS = [
	[ 'mac', _('Peer') ],
	[ 'mesh plink', _('Peer link') ],
	[ 'signal', _('Signal') ],
	[ 'signal avg', _('Signal average') ],
	[ 'mesh airtime link metric', _('Airtime metric') ],
	[ 'tx bitrate', _('Transmit rate') ],
	[ 'rx bitrate', _('Receive rate') ],
	[ 'inactive time', _('Inactive') ],
	[ 'connected time', _('Connected') ]
];

return view.extend({
	/* one setup value as display text */
	setupValue: function(key, v) {
		if (key == 'node_type' && v) {
			return common.nodeTypeText(v);
		}
		if (key == 'debuglevel' && DEBUGLEVEL[String(v)]) {
			return '%s (%s)'.format(v, DEBUGLEVEL[String(v)]);
		}
		if (key == 'enabled') {
			return (v == 1) ? _('yes') : _('no');
		}
		if (key == 'loop_interval' && v !== '') {
			return _('%s seconds').format(v);
		}
		return common.text(v);
	},

	/* a two column table of [ title, text ] rows */
	renderPairs: function(rows) {
		return E('table', { 'class': 'table' }, rows.map(function(r) {
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left', 'width': '33%' }, [ r[0] ]),
				E('td', { 'class': 'td left', 'style': 'overflow-wrap:anywhere' }, [ r[1] ])
			]);
		}));
	},

	/* a table with a header row; rows are arrays of text */
	renderTable: function(titles, rows, empty) {
		var t;

		if (!rows.length) {
			return E('p', { 'class': 'cbi-value-description' }, [ empty ]);
		}

		t = E('table', { 'class': 'table' }, [
			E('tr', { 'class': 'tr table-titles' }, titles.map(function(h) {
				return E('th', { 'class': 'th' }, [ h ]);
			}))
		]);

		rows.forEach(function(r) {
			t.appendChild(E('tr', { 'class': 'tr' }, r.map(function(c) {
				return E('td', { 'class': 'td' }, [ c ]);
			})));
		});

		return t;
	},

	/*
	 * The node summary, then every setup value as mesh11sd reports it (the summary fields
	 * too) in a collapsible list. The page is rebuilt on every refresh, so the list
	 * remembers whether it was open.
	 */
	renderSetup: function(setup) {
		var self = this;
		var rows = [];
		var all = [];
		var details;

		SUMMARY.forEach(function(f) {
			if (setup[f[0]] !== undefined) {
				rows.push([ f[1], self.setupValue(f[0], setup[f[0]]) ]);
			}
		});

		Object.keys(setup).sort().forEach(function(k) {
			all.push([ k, common.text(setup[k]) ]);
		});

		details = E('details', {}, [
			E('summary', {}, [ _('All setup values') ]),
			this.renderPairs(all)
		]);
		details.open = !!this.setupOpen;
		details.addEventListener('toggle', function() {
			self.setupOpen = details.open;
		});

		return E('div', {}, [
			E('h3', {}, [ _('Node') ]),
			this.renderPairs(rows),
			details
		]);
	},

	/* the one-hop peers of an interface, from the stations reply */
	renderPeers: function(list) {
		var rows = (Array.isArray(list) ? list : []).map(function(sta) {
			return PEER_COLUMNS.map(function(c) {
				return common.text(sta[c[0]]);
			});
		});

		return this.renderTable(PEER_COLUMNS.map(function(c) { return c[1]; }), rows,
			_('No peers.'));
	},

	/* mesh paths (iw mpath dump) from the status reply */
	/* a destination: a link to that node's LuCI in a new tab when its apmond ULA is known */
	destination: function(mac) {
		var ula = common.nodeULA(this.apmondPrefix, mac);
		var url;

		if (!ula) {
			return mac;
		}
		url = 'http://[' + ula + ']/cgi-bin/luci/';
		return E('a', { 'href': url, 'target': '_blank', 'rel': 'noopener', 'title': url }, [ mac ]);
	},

	renderPaths: function(paths) {
		var self = this;
		var rows = Object.keys(paths || {}).sort().map(function(mac) {
			var p = paths[mac] || {};

			return [ self.destination(mac), common.text(p.next_hop), common.text(p.hop_count),
				common.text(p.airtime_metric), common.text(p.mpath_metric),
				common.text(p.hwmp_flags_bitmask) ];
		});

		return this.renderTable([ _('Destination'), _('Next hop'), _('Hops'), _('Airtime metric'),
			_('Path metric'), _('Flags') ], rows, _('No mesh paths.'));
	},

	/* stations (wireless clients) of the mesh and the node that serves each one */
	renderStations: function(stations, iface) {
		var local = String(iface.this_node || '').toLowerCase();
		var rows = Object.keys(stations || {}).sort().map(function(mac) {
			var proxy = (stations[mac] || {}).proxy_node || '';
			var via = common.text(proxy);

			if (proxy && proxy.toLowerCase() == local) {
				via = _('%s (this node)').format(proxy);
			}
			return [ mac, via ];
		});

		return this.renderTable([ _('Station'), _('Served by node') ], rows, _('No stations.'));
	},

	renderInterface: function(ifname, iface, peers) {
		var rows = [];

		IFACE.forEach(function(f) {
			if (iface[f[0]] !== undefined) {
				rows.push([ f[1], common.text(iface[f[0]]) ]);
			}
		});

		return E('div', {}, [
			E('h3', {}, [ _('Mesh interface %s').format(ifname) ]),
			this.renderPairs(rows),
			E('h4', {}, [ _('Peers') ]),
			this.renderPeers(peers),
			E('h4', {}, [ _('Mesh paths') ]),
			this.renderPaths(iface.peers),
			E('h4', {}, [ _('Stations') ]),
			this.renderStations(iface.stations, iface)
		]);
	},

	renderStatus: function(data) {
		var self = this;
		var st = data[0];
		var stations = data[1] || {};
		var out = [];
		var ifs;

		this.apmondPrefix = data[2] || null;

		if (st == null) {
			return E('div', { 'class': 'alert-message error' },
				_('Could not read the mesh11sd status. Is mesh11sd 8 installed and running?'));
		}

		out.push(this.renderSetup(st.setup || {}));

		ifs = Object.keys(st.mesh_interfaces || {}).sort();
		if (!ifs.length) {
			out.push(E('div', { 'class': 'alert-message notice' },
				_('No mesh interface is up.')));
		}
		ifs.forEach(function(ifname) {
			out.push(self.renderInterface(ifname, st.mesh_interfaces[ifname] || {}, stations[ifname]));
		});

		return E('div', {}, out);
	},

	fetch: function() {
		return Promise.all([ common.getStatus(), common.getStations(), common.getApmondPrefix() ]);
	},

	load: function() {
		return this.fetch();
	},

	render: function(data) {
		var self = this;
		var box = E('div', { 'id': 'mesh11sd-status' }, [ this.renderStatus(data) ]);

		poll.add(function() {
			return self.fetch().then(function(d) {
				dom.content(box, self.renderStatus(d));
			});
		}, 10);

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, [ _('Mesh11sd Status') ]),
			E('div', { 'class': 'cbi-map-descr' }, [ _('The status of mesh11sd on this node, refreshed every 10 seconds.') ]),
			E('div', { 'class': 'right' }, [
				E('button', {
					'class': 'btn cbi-button cbi-button-action',
					'title': _('Ask mesh11sd to read its settings again at the start of its next loop, without a restart.'),
					'click': ui.createHandlerFn(this, function() {
						return common.configReload().then(function() {
							ui.addNotification(null, E('p', [ _('mesh11sd will read its settings again at the start of its next loop.') ]), 'info');
						}, function(e) {
							ui.addNotification(null, E('p', [ _('Could not ask mesh11sd to reload: %s').format(e) ]), 'error');
						});
					})
				}, [ _('Reload settings') ])
			]),
			box,
			common.footer()
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
