import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@bestie/i18n';
import { AsyncButton } from '@bestie/ui';
import { Notice } from '@bestie/auth';

type Detector = { detect: (v: HTMLVideoElement) => Promise<{ rawValue: string }[]> };
type DetectorCtor = new (o: { formats: string[] }) => Detector;

const FORMATS = ['code_128', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_39', 'qr_code'];

/** The same code seen again within this many milliseconds is ignored (one item held in front of the camera is one scan). */
export const SAME_CODE_MS = 2500;

/** Pure rule: accept a detected code unless it is empty or the same as the previous one a moment ago. */
export function acceptCode(
  code: string,
  last: { code: string; at: number } | null,
  now: number,
): boolean {
  const c = code.trim();
  if (c === '') return false;
  return !(last && last.code === c && now - last.at < SAME_CODE_MS);
}

export const cameraScanSupported = (): boolean =>
  typeof window !== 'undefined' &&
  'BarcodeDetector' in window &&
  typeof navigator !== 'undefined' &&
  !!navigator.mediaDevices?.getUserMedia;

/**
 * Scan barcodes with the device camera (the browser's BarcodeDetector: Chrome / Edge / Android; iPad Safari does not have it, so the
 * typed box and a handheld scanner stay the main way). The camera stays open so a stack of items can be scanned one after another.
 */
export function CameraScan({ onCode }: { onCode: (code: string) => void | Promise<void> }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const onCodeRef = useRef(onCode);
  useEffect(() => {
    onCodeRef.current = onCode;
  });

  useEffect(() => {
    if (!open) return;
    let stream: MediaStream | null = null;
    let timer = 0;
    let alive = true;
    let last: { code: string; at: number } | null = null;
    (async () => {
      try {
        const Ctor = (window as unknown as { BarcodeDetector: DetectorCtor }).BarcodeDetector;
        const detector = new Ctor({ formats: FORMATS });
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        if (!alive || !video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        timer = window.setInterval(async () => {
          const v = video.current;
          if (!v || v.readyState < 2) return;
          try {
            const found = await detector.detect(v);
            const code = found[0]?.rawValue ?? '';
            if (acceptCode(code, last, Date.now())) {
              last = { code: code.trim(), at: Date.now() };
              await onCodeRef.current(code.trim());
            }
          } catch {
            // one unreadable frame is normal; the next one tries again
          }
        }, 350);
      } catch {
        if (alive) setError(true);
      }
    })();
    return () => {
      alive = false;
      window.clearInterval(timer);
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, [open]);

  if (!cameraScanSupported()) return <p className="muted">{t.cameraUnsupported}</p>;
  if (!open)
    return (
      <AsyncButton
        variant="secondary"
        onClick={() => {
          setError(false);
          setOpen(true);
        }}
      >
        {t.cameraOpen}
      </AsyncButton>
    );
  return (
    <div className="camera-scan">
      {error ? <Notice kind="error">{t.cameraDenied}</Notice> : null}
      <video ref={video} playsInline muted aria-label={t.cameraOpen} />
      <AsyncButton variant="secondary" onClick={() => setOpen(false)}>
        {t.cameraClose}
      </AsyncButton>
    </div>
  );
}
