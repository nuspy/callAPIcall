import { Capacitor } from "@capacitor/core";
import { Filesystem, Directory } from "@capacitor/filesystem";

async function urlToBase64(url: string): Promise<string> {
  if (url.startsWith("data:")) return url.split(",")[1] ?? "";
  const res = await fetch(url);
  const blob = await res.blob();
  return await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => resolve((r.result as string).split(",")[1] ?? "");
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

/** Salva un media nei Documenti del dispositivo. Ritorna l'URI.
 *
 *  `nomeOriginale`, quando c'e', vince sul nome generato: un allegato che si
 *  chiama `bilancio-2026.pdf` va ritrovato con quel nome, non come
 *  `callapicall_1789...`. Resta il ripiego per immagini e video, che dal
 *  modello arrivano senza nome. */
export async function saveMediaToDevice(
  url: string,
  kind: "image" | "video" | "file",
  nomeOriginale?: string,
): Promise<string> {
  const ext = kind === "video" ? "mp4" : kind === "file" ? "bin" : "jpg";
  const name = nomeOriginale?.trim() || `callapicall_${Date.now()}.${ext}`;
  if (!Capacitor.isNativePlatform()) {
    // Nel browser i "Documenti" non esistono: l'implementazione web di
    // Filesystem scriverebbe in IndexedDB, cioè in un posto che l'utente non
    // trova più. Qui salvare vuol dire scaricare, e il nome del file è quello
    // che si vedrà nella cartella dei download.
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    return name;
  }
  const data = await urlToBase64(url);
  const res = await Filesystem.writeFile({
    path: name,
    data,
    directory: Directory.Documents,
    recursive: true,
  });
  return res.uri;
}
