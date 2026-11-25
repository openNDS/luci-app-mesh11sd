# luci-app-mesh11sd

LuCI app for [mesh11sd](https://github.com/openNDS/mesh11sd) 8.x, the 802.11s mesh and access
point manager for OpenWrt.

Development happens here. The app directory `openwrt/luci-app-mesh11sd/` is laid out exactly like
`applications/luci-app-mesh11sd` in [openwrt/luci](https://github.com/openwrt/luci) (a `luci.mk`
Makefile, `htdocs/`, `root/` and `po/`), and a feed pull request is a straight copy of it.

## Workflow

* Work is done on a beta branch (for example `1.0.0beta`) and merged to `master` through a pull
  request in this repository.
* A release is tagged on `master` (`vX.Y.Z`).
* For the feed, copy the app directory into an openwrt/luci checkout and open or update the pull
  request there:

      tools/feed-sync.sh copy  /path/to/openwrt-luci    # replaces applications/luci-app-mesh11sd
      tools/feed-sync.sh check /path/to/openwrt-luci    # diff only; exit 0 if they match

## mesh11sd 8

luci-app-mesh11sd reads mesh11sd over its `mesh11sd` ubus object, which is new in mesh11sd 8, so it
needs mesh11sd 8 or later (for now 8.0.0_beta1-r76, for `auto_config_test`, the running values and `unsaved_config` in status). There was no LuCI app for mesh11sd 7.

## Pages

Services > Mesh11sd has three tabs:

* **Status** - `ubus call mesh11sd status` and `ubus call mesh11sd stations`, refreshed every 10
  seconds: the node (version, service state, node type, label MAC, auto config, portal detect,
  access points, band, driver, transmit power, loop interval and debug level, with every setup
  value as mesh11sd reports it under "All setup values", which stays open or closed across
  refreshes), then for each mesh interface its mesh ID, radio, channel,
  active portal and counters, the one-hop peers (peer link state, signal, airtime metric, rates),
  the mesh paths and the stations with the node that serves each one. "Reload settings" calls
  `config_reload`. Neither reply contains a key. When apmond runs on this node, each mesh path
  destination links to that node's LuCI in a new tab, at its apmond ULA: the /64 of this node's
  `node_ula` (`ubus call apmond status`) plus the EUI-64 of the destination's mesh MAC, as apmond
  forms its own `node_ula`. Without apmond the destinations are plain text.
* **Settings** - the options of `config mesh11sd 'setup'` in `/etc/config/mesh11sd`, in General,
  Mesh backhaul, Gate and SSID, and Advanced tabs. Every option is optional: the mesh11sd defaults
  are shown as placeholders and an option is only written when you change it. Keys are password
  fields. Each option says when a change takes effect, as in "Applying changes" in the mesh11sd
  README: on Save & Apply, when the wireless and network configuration is built (normally at
  first configuration), or after a reboot. Save & Apply commits the `mesh11sd` config only; the
  init script's reload trigger then runs `service mesh11sd reload`, so the daemon reads its
  settings again without a restart. The `mesh_params` section is not edited here.
  While a saved option that mesh11sd reads only when it starts differs from the running
  daemon's (`restart_needed` in status), a notice at the top and the General tab offer "Reboot
  node" (LuCI's standard `system` `reboot` call), after a warning that the node's role and
  addresses may change and the page will stop responding. A reboot rather than
  `service mesh11sd restart`: the restart reverts staged network changes without reloading
  them, while a reboot starts clean from the saved configuration.
  While the running mesh11sd has auto config 0, the General tab has a "Run confidence test" button: it
  starts the uncommitted auto config test (`ubus call mesh11sd auto_config_test`, as
  `mesh11sd auto_config test`), after a warning that the node's address changes and the page
  stops responding. A reboot undoes the test.
* **Log** - `mesh11sd read_log`, with Refresh and Follow (re-read every 10 seconds).
* **Status > Overview** - a Mesh11sd section with the live state: node type, version, auto config,
  what is not saved to flash, each mesh interface (channel, mesh ID, active peers, active portal
  and portal ULA), a box per radio in the style of LuCI's own Wireless section but with a green
  head (type, channel, country, noise, TX power, and each live interface with its SSID or mesh ID,
  mode and state), and below them a table of the wireless interfaces netifd really runs (SSID or
  mesh ID, mode, radio, network, up or down). The wireless data is luci-rpc `getWirelessDevices`
  (network.wireless status with live iwinfo), which luci-base already grants to every session.
* **Notice on every page** - mesh11sd applies much of its configuration as uncommitted uci changes,
  so nothing extra is written to flash. LuCI's own pages read only the saved configuration, so its
  Network and Wireless pages can show access points as disabled, leave out interfaces mesh11sd
  added, or mark them for deletion. While `unsaved_config` in status lists any package, a header
  indicator ("Mesh11sd live config") is shown on every page; clicking it opens a popup with the
  explanation, a button to Services > Mesh11sd and Close. On the Network pages one notice says
  that the pages show the saved configuration and links to Services > Mesh11sd. It is a
  preload class (`htdocs/luci-static/resources/preload/mesh11sd.js`), as luci-mod-battstatus uses.

A possible future version: commit the configuration once for the fixed-role node types
(`portal_detect` 0, 3, 4 and 5), at first configuration and when the mesh11sd config changes, not
on every boot, so LuCI's own pages show the real state there. Peers that pick their role at run
time (`portal_detect` 1) would still need the notice.

## How it works

The app is plain LuCI JavaScript. There is no ucode, Lua, CGI or rpcd plugin: settings are a
standard `form.Map('mesh11sd')`, and the other pages call the `mesh11sd` ubus object through rpcd
with `rpc.declare()`. The rpcd ACL
(`openwrt/luci-app-mesh11sd/root/usr/share/rpcd/acl.d/luci-app-mesh11sd.json`) allows reading
`status`, `stations` and `version`, `apmond` `status` (mesh path links), `iwinfo` `countrylist`
(the Country list, as LuCI's wireless page), the uci config `mesh11sd`, and one command,
`/usr/sbin/mesh11sd read_log`; and writing `config_reload`, `auto_config_test`, the uci config
`mesh11sd`, and `system` `reboot` for Reboot node (the same entry as System > Reboot).
Nothing can be committed, reverted or restored through the `mesh11sd` ubus object.

## Building

`openwrt/luci-app-mesh11sd/Makefile` uses `../../luci.mk`, so it builds inside the luci feed tree.
In an OpenWrt build tree or SDK with the luci feed installed:

    tools/feed-sync.sh copy feeds/luci
    ./scripts/feeds update -i luci
    ./scripts/feeds install -p luci luci-app-mesh11sd
    make package/feeds/luci/luci-app-mesh11sd/compile

Or let the sync tool do all of that for the current checkout:

    tools/feed-sync.sh build-beta /path/to/sdk [version] [release]

On a branch named `X.Y.Zbeta` the apk is versioned `X.Y.Z_beta`. The package is architecture
independent. The version shown in the LuCI footer comes from `common.js`.

## Layout

```
openwrt/luci-app-mesh11sd/                     # = applications/luci-app-mesh11sd in openwrt/luci
  Makefile                                     # luci.mk package Makefile, as in the feed
  htdocs/luci-static/resources/view/mesh11sd/  # The views and common.js
  htdocs/luci-static/resources/view/status/include/65_mesh11sd.js  # Status > Overview section
  htdocs/luci-static/resources/preload/mesh11sd.js  # Notice on every page while config is unsaved
  root/usr/share/luci/menu.d/                  # Menu entry, Services > Mesh11sd
  root/usr/share/rpcd/acl.d/                   # rpcd ACL
  po/templates/mesh11sd.pot                    # Translation template
tools/feed-sync.sh                             # Copy to / check against an openwrt/luci checkout
```

## Translations

`openwrt/luci-app-mesh11sd/po/templates/mesh11sd.pot` is generated with
`./build/i18n-scan.pl applications/luci-app-mesh11sd` in an openwrt/luci checkout, so its paths
are the feed paths.
