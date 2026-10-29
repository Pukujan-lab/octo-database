import { useCallback, useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";

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
 * The centrepiece. Square, full-bleed on a phone, muted and inline, and it
 * starts itself when it scrolls into view and stops when it leaves. The frame
 * is sized by aspect ratio, so no state of loading can move the page.
 */
export function CredentialVideo() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const pausedByHand = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  const play = useCallback(() => {
    const started = videoRef.current?.play();
    if (started) started.catch(() => setPlaying(false));
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = true;
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            if (!pausedByHand.current) play();
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

  const toggle = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      pausedByHand.current = false;
      play();
    } else {
      pausedByHand.current = true;
      video.pause();
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
        muted
        loop
        preload="metadata"
        aria-label="Ninety seconds, silent: give it everything, hand it nothing."
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
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? "Pause the film" : "Play the film"}
          className="absolute bottom-3 right-3 inline-flex items-center gap-2 border border-border bg-background/85 px-3 py-2 font-display text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground backdrop-blur transition-colors duration-500 hover:border-info/60 hover:text-info"
        >
          {playing ? (
            <Pause className="h-3.5 w-3.5" strokeWidth={1.5} />
          ) : (
            <Play className="h-3.5 w-3.5" strokeWidth={1.5} />
          )}
          <span>{playing ? "Pause" : "Play"}</span>
        </button>
      )}
    </div>
  );
}
