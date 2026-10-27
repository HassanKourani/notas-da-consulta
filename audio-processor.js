// AudioWorklet: converts the microphone stream to 16 kHz mono and posts it
// to the main thread in 512-sample frames (32 ms each).
const TARGET_RATE = 16000;
const FRAME = 512;

class Downsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.pos = 0; // fractional read position into the incoming stream
    this.prev = 0; // last sample of the previous block, for interpolation
    this.out = new Float32Array(FRAME);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    // Linear interpolation; index -1 refers to the previous block's last sample.
    while (this.pos < ch.length) {
      const i = Math.floor(this.pos);
      const f = this.pos - i;
      const a = i === 0 ? this.prev : ch[i - 1];
      const b = ch[i];
      this.out[this.n++] = a + (b - a) * f;
      if (this.n === FRAME) {
        this.port.postMessage(this.out.slice());
        this.n = 0;
      }
      this.pos += this.ratio;
    }
    this.pos -= ch.length;
    this.prev = ch[ch.length - 1];
    return true;
  }
}

registerProcessor('downsampler', Downsampler);
