/**
 * Procedural C418 / Minecraft-inspired relaxing ambient felt-piano & pad synthesizer
 * Built with 100% Web Audio API (zero external audio file dependencies).
 */

// MIDI note to frequency helper
function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// Nostalgic Maj7 / Add9 / 6th voicings reminiscent of "Sweden" & "Subwoofer Lullaby"
const CHORD_PROGRESSIONS: number[][] = [
  // I: Cmaj9 (C3, G3, B3, D4, E4)
  [48, 55, 59, 62, 64],
  // IV: Fmaj7#11 (F2, C3, E3, A3, B3, E4)
  [41, 48, 52, 57, 59, 64],
  // vi: Am9 (A2, E3, G3, B3, C4, E4)
  [45, 52, 55, 59, 60, 64],
  // V6: G6add9 (G2, D3, E3, A3, B3, D4)
  [43, 50, 52, 57, 59, 62],
  // bVII: Bbmaj7 (Bb2, F3, A3, C4, D4)
  [46, 53, 57, 60, 62],
  // ii9: Dm9 (D3, A3, C4, E4, F4)
  [50, 57, 60, 64, 65],
];

const MELODY_SCALE = [60, 62, 64, 67, 69, 71, 72, 74, 76, 79]; // C major pentatonic + 7th/9th

export class AmbientMusicEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private reverbInput: GainNode | null = null;
  private isPlaying = false;
  private timerId: number | null = null;
  private stepIndex = 0;
  private chordIndex = 0;

  public start(): void {
    if (this.isPlaying) return;

    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!this.ctx) {
      this.ctx = new AudioCtx();
      this.setupAudioGraph();
    }

    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }

    this.isPlaying = true;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.cancelScheduledValues(this.ctx.currentTime);
      this.masterGain.gain.setValueAtTime(0.001, this.ctx.currentTime);
      this.masterGain.gain.linearRampToValueAtTime(0.32, this.ctx.currentTime + 1.5);
    }

    this.scheduleNextPhrase();
  }

  public stop(): void {
    if (!this.isPlaying) return;
    this.isPlaying = false;

    if (this.timerId !== null) {
      window.clearTimeout(this.timerId);
      this.timerId = null;
    }

    if (this.masterGain && this.ctx) {
      const now = this.ctx.currentTime;
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
      this.masterGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.8);
    }
  }

  public dispose(): void {
    this.stop();
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }

  private setupAudioGraph(): void {
    if (!this.ctx) return;

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.32;
    this.masterGain.connect(this.ctx.destination);

    // Lush algorithmic stereo delay/reverb network
    this.reverbInput = this.ctx.createGain();
    this.reverbInput.gain.value = 1.0;

    // Dry path
    this.reverbInput.connect(this.masterGain);

    // Multi-tap warm feedback delays for spacious ambient tail
    const delayTimes = [0.27, 0.43, 0.61];
    delayTimes.forEach((time, idx) => {
      if (!this.ctx || !this.reverbInput || !this.masterGain) return;
      const delay = this.ctx.createDelay(2.0);
      delay.delayTime.value = time;

      const feedback = this.ctx.createGain();
      feedback.gain.value = 0.42 - idx * 0.05;

      const dampFilter = this.ctx.createBiquadFilter();
      dampFilter.type = 'lowpass';
      dampFilter.frequency.value = 1350 - idx * 200;

      const wetGain = this.ctx.createGain();
      wetGain.gain.value = 0.22;

      this.reverbInput.connect(delay);
      delay.connect(dampFilter);
      dampFilter.connect(feedback);
      feedback.connect(delay);
      dampFilter.connect(wetGain);
      wetGain.connect(this.masterGain);
    });
  }

  /**
   * Plays a soft felt-piano note with gentle hammer warmth and long decay
   */
  private playFeltPianoNote(midi: number, timeOffset: number, velocity = 0.25, duration = 4.2): void {
    if (!this.ctx || !this.reverbInput || !this.isPlaying) return;

    const now = this.ctx.currentTime + timeOffset;
    const freq = midiToFreq(midi);

    const noteGain = this.ctx.createGain();
    noteGain.gain.setValueAtTime(0.0001, now);
    // Soft felt attack
    noteGain.gain.linearRampToValueAtTime(velocity, now + 0.065);
    // Warm exponential piano decay
    noteGain.gain.exponentialRampToValueAtTime(velocity * 0.35, now + 0.7);
    noteGain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(freq * 3.2, now);
    filter.frequency.exponentialRampToValueAtTime(Math.max(freq * 1.15, 260), now + duration * 0.8);

    // Fundamental sine
    const osc1 = this.ctx.createOscillator();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(freq, now);

    // Warm detuned triangle harmonic
    const osc2 = this.ctx.createOscillator();
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(freq, now);
    osc2.detune.setValueAtTime(4.5, now);

    const osc2Gain = this.ctx.createGain();
    osc2Gain.gain.value = 0.28;

    osc1.connect(filter);
    osc2.connect(osc2Gain);
    osc2Gain.connect(filter);

    filter.connect(noteGain);
    noteGain.connect(this.reverbInput);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + duration + 0.1);
    osc2.stop(now + duration + 0.1);
  }

  /**
   * Plays a warm, breathing sub-pad swell underneath the piano
   */
  private playWarmPadSwell(midiRoot: number, midiFifth: number, duration = 6.5): void {
    if (!this.ctx || !this.reverbInput || !this.isPlaying) return;

    const now = this.ctx.currentTime;
    const padGain = this.ctx.createGain();
    padGain.gain.setValueAtTime(0.0001, now);
    padGain.gain.linearRampToValueAtTime(0.085, now + 2.2);
    padGain.gain.linearRampToValueAtTime(0.06, now + duration * 0.7);
    padGain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(380, now);

    [midiRoot, midiFifth].forEach((note, i) => {
      if (!this.ctx) return;
      const osc = this.ctx.createOscillator();
      osc.type = i === 0 ? 'sine' : 'triangle';
      osc.frequency.setValueAtTime(midiToFreq(note), now);
      osc.detune.setValueAtTime(i === 0 ? -3 : 3, now);
      osc.connect(filter);
      osc.start(now);
      osc.stop(now + duration + 0.1);
    });

    filter.connect(padGain);
    padGain.connect(this.reverbInput);
  }

  private scheduleNextPhrase(): void {
    if (!this.isPlaying) return;

    const chord = CHORD_PROGRESSIONS[this.chordIndex % CHORD_PROGRESSIONS.length];

    // Play a warm pad swell on the root and fifth
    this.playWarmPadSwell(chord[0], chord[1], 6.8);

    // Gently arpeggiate 3 to 4 notes of the chord like a slow C418 piano phrase
    const spacing = 0.62 + Math.random() * 0.18;
    chord.forEach((note, idx) => {
      const vel = idx === 0 ? 0.24 : 0.16 + Math.random() * 0.06;
      this.playFeltPianoNote(note, idx * spacing, vel, 4.8);
    });

    // Add 1 or 2 sparse high melody notes with breathing room
    const melodyNote1 = MELODY_SCALE[(this.stepIndex * 3 + 2) % MELODY_SCALE.length];
    this.playFeltPianoNote(melodyNote1, chord.length * spacing + 0.55, 0.19, 4.5);

    if (this.stepIndex % 2 === 0) {
      const melodyNote2 = MELODY_SCALE[(this.stepIndex * 5 + 1) % MELODY_SCALE.length];
      this.playFeltPianoNote(melodyNote2, chord.length * spacing + 1.65, 0.15, 4.8);
    }

    this.stepIndex++;
    this.chordIndex = (this.chordIndex + 1) % CHORD_PROGRESSIONS.length;

    // Wait 6.4 - 7.4 seconds before the next phrase for a calm, unhurried atmosphere
    const nextDelayMs = 6500 + Math.random() * 900;
    this.timerId = window.setTimeout(() => this.scheduleNextPhrase(), nextDelayMs);
  }
}
