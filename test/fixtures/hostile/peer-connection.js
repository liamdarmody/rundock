// Tries the channel no Content-Security-Policy governs: a WebRTC peer
// connection whose STUN traffic goes to the listener's UDP port.
window.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'init') {
    try {
      var pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:__UDP__' }] });
      pc.createDataChannel('x');
      pc.createOffer().then(function (o) { return pc.setLocalDescription(o); });
    } catch (err) { /* blocked is the outcome being tested for */ }
  }
});
parent.postMessage({ type: 'ready' }, '*');
