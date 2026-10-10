// The VM screen in the browser: a thin wrapper around noVNC's RFB class
// (public/vendor/novnc, MPL 2.0) for app.js, which is a classic script and
// cannot import an ES module itself. The relay is the manager's own
// WebSocket route GET /api/vm/screen?name=&token= (lib/screen.js).
//
// window.DevboxScreen.open(target, {name, token, scale, onStatus, onDisconnect})
//   -> {rfb, close(), setScale(on), ctrlAltDel(), focus()}
import RFB from './vendor/novnc/core/rfb.js';

function wsUrl(name, token) {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  return proto + location.host + '/api/vm/screen?name=' + encodeURIComponent(name) + '&token=' + encodeURIComponent(token || '');
}

function open(target, o) {
  const rfb = new RFB(target, wsUrl(o.name, o.token), { wsProtocols: ['binary'], shared: true });
  rfb.scaleViewport = o.scale !== false;
  rfb.resizeSession = false;
  rfb.clipViewport = false;
  rfb.background = '#0b0d11';
  rfb.addEventListener('connect', () => { if (o.onStatus) o.onStatus('connected'); });
  rfb.addEventListener('disconnect', (e) => {
    if (o.onDisconnect) o.onDisconnect(e && e.detail && e.detail.clean);
  });
  rfb.addEventListener('credentialsrequired', () => { rfb.sendCredentials({ password: '' }); });
  rfb.addEventListener('securityfailure', (e) => { if (o.onStatus) o.onStatus('refused: ' + (e.detail && e.detail.reason)); });
  rfb.addEventListener('desktopname', (e) => { if (o.onName) o.onName(e.detail && e.detail.name); });
  return {
    rfb: rfb,
    close() { try { rfb.disconnect(); } catch (e) { /* already gone */ } },
    setScale(on) { rfb.scaleViewport = !!on; },
    ctrlAltDel() { rfb.sendCtrlAltDel(); },
    focus() { rfb.focus(); },
  };
}

window.DevboxScreen = { open: open };
