chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'PLAY_SOUND') {
    playAlert();
  }
});

function playAlert() {
  const ctx = new AudioContext();
  const freqs = [800, 1000, 1200, 1000, 1200, 1400];
  let t = ctx.currentTime;
  for (const freq of freqs) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.value = 0.3;
    gain.gain.exponentialRampToValueAtTime(0.01, t + 0.3);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.3);
    t += 0.35;
  }
}
