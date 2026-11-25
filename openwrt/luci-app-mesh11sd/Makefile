# SPDX-License-Identifier: GPL-2.0-or-later
#
# Copyright (C) 2026 Rob White <rob@blue-wave.net>
#

include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI support for mesh11sd
LUCI_DESCRIPTION:=Status, settings and log for mesh11sd 8.x, the 802.11s mesh and access point manager.
LUCI_DEPENDS:=+luci-base +mesh11sd
LUCI_EXTRA_DEPENDS:=mesh11sd (>=8.0.0_beta1-r76)

PKG_VERSION:=1.0.0_beta
PKG_RELEASE:=2
PKG_LICENSE:=GPL-2.0-or-later
PKG_MAINTAINER:=Rob White <rob@blue-wave.net>

include ../../luci.mk

# call BuildPackage - OpenWrt buildroot signature
