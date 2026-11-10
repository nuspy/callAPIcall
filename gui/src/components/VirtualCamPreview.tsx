import React, { useEffect, useRef, useState } from "react";
import { Video, VideoOff } from "lucide-react";
import { useTranslation } from "react-i18next";

interface VirtualCamPreviewProps {
  /** Aggancia la camera solo quando true (avatar in esecuzione). */
  active: boolean;
  className?: string;
}

/**
 * Anteprima live della webcam virtuale "OBS Virtual Camera": mostra in GUI
 * lo stesso video che vedrebbero Meet/Zoom/Teams. Il filtro DirectShow
 * supporta piu' lettori contemporanei, quindi l'anteprima non ruba la camera
 * alla videocall.
 */
export const VirtualCamPreview: React.FC<VirtualCamPreviewProps> = ({
  active,
  className = "",
}) => {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [attached, setAttached] = useState(false);

  useEffect(() => {
    if (!active) {
      setAttached(false);
      setError(null);
      return;
    }
    let stream: MediaStream | null = null;
    let cancelled = false;

    const findObsCam = async (): Promise<MediaDeviceInfo | undefined> => {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.find(
        (d) => d.kind === "videoinput" && /obs/i.test(d.label),
      );
    };

    (async () => {
      try {
        let cam = await findObsCam();
        if (!cam) {
          // Le label restano vuote finche' non c'e' stato un permesso camera:
          // apri (e richiudi subito) una camera qualsiasi, poi ri-enumera.
          const tmp = await navigator.mediaDevices.getUserMedia({ video: true });
          tmp.getTracks().forEach((t) => t.stop());
          cam = await findObsCam();
        }
        if (!cam) {
          setError(t("virtualCam.notFound"));
          return;
        }
        stream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: cam.deviceId } },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
        setAttached(true);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
      setAttached(false);
    };
  }, [active]);

  return (
    <div
      className={`rounded-lg border border-mid-gray/20 overflow-hidden bg-black/60 ${className}`}
    >
      {active ? (
        <>
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className={`w-full aspect-video object-contain ${attached ? "" : "hidden"}`}
          />
          {!attached && (
            <div className="aspect-video flex flex-col items-center justify-center gap-2 text-text/50 text-sm">
              <Video width={22} height={22} className="animate-pulse" />
              {error ?? t("virtualCam.attaching")}
            </div>
          )}
        </>
      ) : (
        <div className="aspect-video flex flex-col items-center justify-center gap-2 text-text/40 text-sm">
          <VideoOff width={22} height={22} />
          {t("virtualCam.off")}
        </div>
      )}
    </div>
  );
};
