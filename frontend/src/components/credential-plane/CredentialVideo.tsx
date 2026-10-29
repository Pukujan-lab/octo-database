import { useCallback, useEffect, useRef, useState } from "react";
import { Pause, Play, Volume2, VolumeX } from "lucide-react";

const VIDEO_SRC = "/credential-plane.mp4";
const POSTER_SRC = "/credential-plane-poster.jpg";

/**
 * The plate that sits under the film: hairline grid and the Octo hexagon, drawn
 * in tokens. The square holds its shape and reads as a technical surface even
 * before the first frame arrives.
 */
function WirePlate() {
  return (
    <div aria-hidden="true" className="absolute inset-0 overflow-hidden">
      <div className="motif-grid absolute inset-0 opacity-30" />
      <svg
        viewBox="0 0 400 400"
        className="absolute inset-0 h-full w-full text-info/25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      >
        <polygon points="200,64 318,132 318,268 200,336 82,268 82,132" />
        <polygon points="200,118 272,160 272,240 200,282 128,240 128,160" className="text-info/15" />
        <line x1="200" y1="64" x2="200" y2="336" />
        <line x1="82" y1="132" x2="318" y2="268" />
        <line x1="318" y1="132" x2="82" y2="268" />
        <circle cx="200" cy="200" r="3" className="fill-info/60" stroke="none" />
      </svg>
    </div>
  );
}

/**
 * The centrepiece. Square, full-bleed on a phone and inline. It starts itself
 * when it scrolls into view and stops when it leaves.
 *
 * Sound is attempted first, not last: a visitor who has already clicked
 * anywhere on the page is allowed to hear it, and starting muted meant nobody
 * ever did. Only when the browser refuses does it fall back to a silent start,
 * which the control then offers to undo. The frame is sized by aspect ratio, so
 * no state of loading can move the page.
 */
export function CredentialVideo() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const pausedByHand = useRef(false);
  const soundChoice = useRef<boolean | null>(null);
  const [playing, setPlaying] = useState(false);
  const [soundOn, setSoundOn] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  const play = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    if (soundChoice.current !== false) {
      video.muted = false;
      try {
        await video.play();
        soundChoice.current = true;
        setSoundOn(true);
        return;
      } catch {
        video.muted = true;
        setSoundOn(false);
      }
    }
    try {
      await video.play();
    } catch {
      setPlaying(false);
    }
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            if (!pausedByHand.current) void play();
          } else {
            video.pause();
          }
        }
      },
      { threshold: 0.4 },
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, [play]);

  /**
   * The first gesture anywhere on the page is the moment the browser will
   * allow sound. Without this the film stays silent for a visitor who reads
   * before they reach the video, which is most of them.
   */
  useEffect(() => {
    if (soundChoice.current !== null) return;
    const unlock = () => {
      const video = videoRef.current;
      if (!video || soundChoice.current !== null) return;
      video.muted = false;
      soundChoice.current = true;
      setSoundOn(true);
    };
    const opts = { once: true, passive: true } as const;
    window.addEventListener("pointerdown", unlock, opts);
    window.addEventListener("keydown", unlock, opts);
    window.addEventListener("touchstart", unlock, opts);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      window.removeEventListener("touchstart", unlock);
    };
  }, []);

  const toggle = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      pausedByHand.current = false;
      void play();
    } else {
      pausedByHand.current = true;
      video.pause();
    }
  };

  const toggleSound = () => {
    const video = videoRef.current;
    if (!video) return;
    const next = !soundOn;
    video.muted = !next;
    soundChoice.current = next;
    setSoundOn(next);
    if (next && video.paused) {
      pausedByHand.current = false;
      void play();
    }
  };

  return (
    <div className="relative aspect-square w-full overflow-hidden border border-border bg-background">
      <WirePlate />
      <video
        ref={videoRef}
        className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-700 ${
          unavailable ? "opacity-0" : "opacity-100"
        }`}
        src={VIDEO_SRC}
        poster={POSTER_SRC}
        playsInline
        loop
        preload="metadata"
        aria-label="One hundred seconds: give it everything, hand it nothing."
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onError={() => {
          setUnavailable(true);
          setPlaying(false);
        }}
      />

      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <span className="absolute left-0 top-0 h-5 w-5 border-l border-t border-info/50" />
        <span className="absolute right-0 top-0 h-5 w-5 border-r border-t border-info/50" />
        <span className="absolute bottom-0 left-0 h-5 w-5 border-b border-l border-info/50" />
        <span className="absolute bottom-0 right-0 h-5 w-5 border-b border-r border-info/50" />
      </div>

      {unavailable ? null : (
        <div className="absolute bottom-3 right-3 flex items-center gap-2">
          <button
            type="button"
            onClick={toggleSound}
            aria-label={soundOn ? "Mute the narration" : "Unmute the narration"}
            aria-pressed={soundOn}
            className="inline-flex items-center gap-2 border border-border bg-background/85 px-3 py-2 font-display text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground backdrop-blur transition-colors duration-500 hover:border-info/60 hover:text-info"
          >
            {soundOn ? (
              <Volume2 className="h-3.5 w-3.5" strokeWidth={1.5} />
            ) : (
              <VolumeX className="h-3.5 w-3.5" strokeWidth={1.5} />
            )}
            <span>{soundOn ? "Sound on" : "Sound off"}</span>
          </button>
          <button
            type="button"
            onClick={toggle}
            aria-label={playing ? "Pause the film" : "Play the film"}
            className="inline-flex items-center gap-2 border border-border bg-background/85 px-3 py-2 font-display text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground backdrop-blur transition-colors duration-500 hover:border-info/60 hover:text-info"
          >
            {playing ? (
              <Pause className="h-3.5 w-3.5" strokeWidth={1.5} />
            ) : (
              <Play className="h-3.5 w-3.5" strokeWidth={1.5} />
            )}
            <span>{playing ? "Pause" : "Play"}</span>
          </button>
        </div>
      )}
    </div>
  );
}
