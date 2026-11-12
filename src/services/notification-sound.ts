export type SoundPreset = 'OFF' | 'GENTLE' | 'DOUBLE' | 'URGENT';
let audio: AudioContext | undefined;
export function notificationSoundEnabled(): boolean {
  return audio?.state === 'running';
}
export async function enableNotificationSound(): Promise<void> {
  audio ??= new AudioContext();
  await audio.resume();
}
export function playNotificationSound(preset: SoundPreset, volume: number): void {
  if (!audio || audio.state !== 'running' || preset === 'OFF') return;
  const level = Math.min(0.15, Math.max(0, volume / 100) * 0.15);
  const notes = preset === 'URGENT' ? [880, 660, 880] : preset === 'DOUBLE' ? [660, 880] : [660];
  for (let index = 0; index < notes.length; index++) {
    const at = audio.currentTime + index * 0.22,
      oscillator = audio.createOscillator(),
      gain = audio.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = notes[index]!;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(level, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.18);
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.start(at);
    oscillator.stop(at + 0.2);
    oscillator.addEventListener(
      'ended',
      () => {
        oscillator.disconnect();
        gain.disconnect();
      },
      { once: true },
    );
  }
}
