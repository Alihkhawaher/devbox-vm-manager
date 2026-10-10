# Third-party notices

devbox VM Manager itself is MIT-licensed (see [LICENSE](LICENSE)). It ships
the following third-party material unmodified.

## noVNC

`public/vendor/novnc/core/` and `public/vendor/novnc/vendor/pako/` are the
`core` library and its vendored pako copy from
[noVNC](https://github.com/novnc/noVNC) 1.7.0, unmodified, used for the
Screen tab of appliance VMs (the manager relays QEMU's VNC server to it over
a WebSocket). The noVNC core library is distributed under the Mozilla Public
License 2.0; pako under the MIT License. The upstream `LICENSE.txt` and
`AUTHORS` files are kept next to them in `public/vendor/novnc/`. The MPL 2.0
requires that the source of these files stays available: it is, unmodified,
in that folder and upstream.

## xterm.js and its fit add-on

`public/vendor/xterm.js`, `public/vendor/xterm.css` and
`public/vendor/xterm-addon-fit.js` are the published UMD builds of
[xterm.js](https://github.com/xtermjs/xterm.js) and its fit add-on, used for
the in-browser terminal and serial console. They are distributed under the
MIT License; the full text and the copyright holders are in the upstream
[LICENSE](https://github.com/xtermjs/xterm.js/blob/master/LICENSE) file:

> Copyright (c) The xterm.js authors (https://github.com/xtermjs/xterm.js),
> SourceLair Private Company (https://www.sourcelair.com) and
> Christopher Jeffrey (https://github.com/chjj/)
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## Alpine Linux package-signing public keys

`lib/microvm/keys/*.rsa.pub` are Alpine Linux's public package-signing keys
(`alpine-devel@lists.alpinelinux.org-*.rsa.pub`), as distributed in Alpine's
`alpine-keys` package ([aports: main/alpine-keys](https://gitlab.alpinelinux.org/alpine/aports/-/tree/master/main/alpine-keys)).
The manager uses them only to verify the signed package index and packages it
downloads (the kernel and busybox for the microVM engine). They are public
keys; no private key material is included.

## Downloaded at run time (not shipped)

On first use the manager downloads, and verifies, software it does not
redistribute: QEMU for Windows (https://qemu.weilnetz.de, Windows only and
only when QEMU is missing), the Alpine Linux cloud image and the Alpine
`linux-virt` and `busybox-static` packages (https://dl-cdn.alpinelinux.org),
and the container images you ask it to run, from their registries. Each is
covered by its own license.
