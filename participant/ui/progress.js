export function syncProgress(previous, current, previousAt, now) {
  if (!previous || !current?.catchingUp || !current.primaryConnected) return null;
  if (![previous.height, current.height].every(value => /^\d+$/.test(String(value)))) return null;
  const before = Number(previous.height), height = Number(current.height);
  const seconds = (now - previousAt) / 1000;
  if (![before, height].every(Number.isSafeInteger) || !Number.isFinite(seconds) || seconds < 5 || seconds > 300 || height <= before) return null;
  const blocksPerSecond = (height - before) / seconds;
  return { blocksPerSecond, secondsPer100: 100 / blocksPerSecond };
}
