const PREFERENCE_KEY = 'geomancer-sound-v1';
const AUDIO_CACHE = 'geomancer-audio-v1';

export const TRACKS = Object.freeze([
  {
    title: 'Frost Waltz',
    src: '/audio/frost-waltz.mp3',
    source: 'https://incompetech.com/music/royalty-free/index.html?Search=Search&isrc=USUAN1100516',
  },
  {
    title: 'Fairytale Waltz',
    src: '/audio/fairytale-waltz.mp3',
    source: 'https://incompetech.com/music/royalty-free/index.html?Search=Search&isrc=USUAN1100232',
  },
  {
    title: 'Mysterioso March',
    src: '/audio/mysterioso-march.mp3',
    source: 'https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1100143',
  },
]);

function loadPreference() {
  try {
    const value = JSON.parse(localStorage.getItem(PREFERENCE_KEY) || 'null');
    return {
      muted: Boolean(value?.muted),
      volume: Math.max(0, Math.min(0.35, Number(value?.volume ?? 0.12))),
    };
  } catch {
    return { muted: false, volume: 0.12 };
  }
}

export function createMusicController() {
  const audio = new Audio();
  const preference = loadPreference();
  const listeners = new Set();
  let index = 0;
  let waitingForGesture = false;
  audio.preload = 'none';
  audio.volume = preference.volume;
  audio.muted = preference.muted;

  function state() {
    return {
      muted: audio.muted,
      volume: audio.volume,
      playing: !audio.paused,
      waitingForGesture,
      track: TRACKS[index],
      index,
    };
  }

  function emit() {
    const snapshot = state();
    listeners.forEach(listener => listener(snapshot));
  }

  function persist() {
    try { localStorage.setItem(PREFERENCE_KEY, JSON.stringify({ muted: audio.muted, volume: audio.volume })); } catch {}
  }

  function selectTrack(nextIndex) {
    index = (nextIndex + TRACKS.length) % TRACKS.length;
    audio.src = TRACKS[index].src;
  }

  async function cacheCurrentTrack() {
    if (!('caches' in window)) return;
    try {
      const cache = await caches.open(AUDIO_CACHE);
      if (!await cache.match(TRACKS[index].src)) await cache.add(TRACKS[index].src);
    } catch {}
  }

  async function play() {
    if (!audio.src) selectTrack(index);
    try {
      await audio.play();
      waitingForGesture = false;
      cacheCurrentTrack();
    } catch {
      waitingForGesture = !audio.muted;
    }
    emit();
  }

  function pause() {
    audio.pause();
    waitingForGesture = false;
    emit();
  }

  async function toggleMuted() {
    audio.muted = !audio.muted;
    persist();
    if (!audio.muted && audio.paused) await play();
    else emit();
  }

  function setVolume(value) {
    audio.volume = Math.max(0, Math.min(0.35, Number(value)));
    if (audio.volume > 0) audio.muted = false;
    persist();
    emit();
  }

  async function next() {
    selectTrack(index + 1);
    await play();
  }

  audio.addEventListener('ended', next);
  audio.addEventListener('play', emit);
  audio.addEventListener('pause', emit);
  audio.addEventListener('error', function() {
    waitingForGesture = false;
    emit();
  });

  const resumeAfterGesture = function() {
    if (waitingForGesture && !audio.muted) play();
  };
  document.addEventListener('pointerdown', resumeAfterGesture, { passive: true });
  document.addEventListener('keydown', resumeAfterGesture);

  queueMicrotask(function() { if (!audio.muted) play(); else emit(); });

  return {
    getState: state,
    play,
    pause,
    next,
    toggleMuted,
    setVolume,
    subscribe(listener) {
      listeners.add(listener);
      listener(state());
      return () => listeners.delete(listener);
    },
  };
}
