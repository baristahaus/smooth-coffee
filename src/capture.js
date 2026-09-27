// Everything that touches getUserMedia. The two-step permission dance is
// deliberate: Chrome-family browsers withhold device labels until the origin has
// been granted microphone access in this session, and there is no way to match
// "BlackHole 2ch" by name before that grant exists.
const LOOPBACK_PATTERN = /(black\W?hole|eqmac|loopback|aggregate|virtual)/i;
const DEFAULTISH = /^(default|communications|default device|communications device)$/i;

export { LOOPBACK_PATTERN };

/** Grants mic access for the origin and returns labelled inputs. */
export async function unlockDeviceLabels(mediaDevices = navigator.mediaDevices) {
  const stream = await mediaDevices.getUserMedia({ audio: true, video: false });
  const devices = await mediaDevices.enumerateDevices();
  stream.getTracks().forEach((track) => track.stop());
  return devices.filter((device) => device.kind === 'audioinput');
}

export async function listInputs(mediaDevices = navigator.mediaDevices) {
  const devices = await mediaDevices.enumerateDevices();
  return devices.filter((device) => device.kind === 'audioinput');
}

/**
 * @returns {MediaDeviceInfo|null} the stored device if it still exists, else the
 * first label that looks like a loopback driver, else the first real device.
 */
export function chooseInput(inputs, { preferredId = null, pattern = LOOPBACK_PATTERN } = {}) {
  const usable = inputs.filter((device) => !DEFAULTISH.test(device.label.trim()));
  const stored = preferredId && usable.find((device) => device.deviceId === preferredId);
  if (stored) return stored;
  const byName = usable.find((device) => pattern.test(device.label));
  if (byName) return byName;
  return usable[0] ?? inputs[0] ?? null;
}

/**
 * Opens one input and wires source -> analyser. Nothing is connected to the
 * audio output on purpose: the routing app keeps playing through the real
 * device, and sending the captured mix to the speakers would just be an echo.
 */
export async function openInput(device, { fftSize = 2048 } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: device.deviceId },
      // The three Web Audio processing blocks are tuned for human speech on a
      // real microphone. Applied to a music mix they duck, filter and level-shift
      // exactly the information the visualiser needs.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    video: false,
  });

  const context = new (window.AudioContext || window.webkitAudioContext)({
    latencyHint: 'interactive',
  });
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = fftSize;
  analyser.smoothingTimeConstant = 0; // own smoothing in features.js
  analyser.minDecibels = -110;
  analyser.maxDecibels = -3;
  source.connect(analyser);
  if (context.state === 'suspended') await context.resume();

  return {
    stream,
    context,
    analyser,
    track: stream.getAudioTracks()[0],
    wave: new Float32Array(analyser.fftSize),
    fftDb: new Float32Array(analyser.frequencyBinCount),
    read() {
      this.analyser.getFloatTimeDomainData(this.wave);
      this.analyser.getFloatFrequencyData(this.fftDb);
    },
    close() {
      stream.getTracks().forEach((track) => track.stop());
      source.disconnect();
      analyser.disconnect();
      context.close();
    },
  };
}
