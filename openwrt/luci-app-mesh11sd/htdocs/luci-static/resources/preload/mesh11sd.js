'use strict';
'require baseclass';
'require poll';
'require ui';
'require view.mesh11sd.common as common';

/*
 * Loaded on every LuCI page (the preload directory, as luci-mod-battstatus does).
 *
 * mesh11sd applies much of the node's configuration as uncommitted uci changes, so it is not
 * written to flash. LuCI's own pages read only the saved configuration, so its Network and
 * Wireless pages can show access points as disabled, leave out interfaces mesh11sd added, or
 * mark them for deletion. While "ubus call mesh11sd status" lists unsaved packages
 * (unsaved_config), this shows a header indicator; on the Network pages it also shows a
 * notice once per page (never more than one). A click on the indicator opens a modal with
 * the same text. Both link to the mesh11sd status page, which shows the live state.
 */

var INDICATOR = 'mesh11sd-unsaved';

return baseclass.extend({
	__init__: function() {
		this.noticeShown = false;
		this.notice = null;
		this.update();
		poll.add(L.bind(this.update, this), 60);
	},

	statusUrl: function() {
		return L.url('admin/services/mesh11sd/status');
	},

	message: function() {
		return _('mesh11sd is running a live configuration that is not saved to flash. The Network and Wireless pages show the saved configuration; see Services > Mesh11sd for the live state.');
	},

	/* the notice at the top of a Network page: at most one, kept while it is not dismissed */
	showNotice: function() {
		var n = this.notice;

		if (n && n.parentNode && !n.classList.contains('fade-out')) {
			return;
		}
		this.notice = ui.addNotification(null, [
			E('p', this.message()),
			E('p', E('a', { 'href': this.statusUrl() }, _('Open Services > Mesh11sd')))
		], 'info');
	},

	/* a click on the indicator: a modal, which replaces any open one, so it never stacks */
	showModal: function() {
		var url = this.statusUrl();

		ui.showModal(_('Live configuration not saved'), [
			E('p', this.message()),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close')),
				' ',
				E('button', {
					'class': 'btn cbi-button-action',
					'click': function() {
						ui.hideModal();
						window.location.href = url;
					}
				}, _('Open Services > Mesh11sd'))
			])
		]);
	},

	update: function() {
		var self = this;

		return common.getStatus().then(function(st) {
			var unsaved = common.unsavedConfig(st);
			var path = L.env.requestpath || [];

			if (!unsaved.length) {
				ui.hideIndicator(INDICATOR);
				return;
			}

			ui.showIndicator(INDICATOR, _('Mesh11sd live config'), function() {
				self.showModal();
			}, 'active');

			if (!self.noticeShown && path[0] == 'admin' && path[1] == 'network') {
				self.noticeShown = true;
				self.showNotice();
			}
		});
	}
});
