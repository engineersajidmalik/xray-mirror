// Webcam access with friendly error messages. Capped at 720p.

export class CameraError extends Error {}

export async function startCamera(video: HTMLVideoElement): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CameraError("This browser cannot access a camera. Try a recent Chrome, Edge or Firefox over http://localhost or https.");
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: "user", width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }, frameRate: { ideal: 30 } },
    });
  } catch (err) {
    const name = (err as DOMException).name;
    if (name === "NotAllowedError" || name === "SecurityError") {
      throw new CameraError("Camera permission was denied. Allow camera access in the address bar (camera icon), then reload the page.");
    }
    if (name === "NotFoundError" || name === "OverconstrainedError") {
      throw new CameraError("No camera was found. Connect a webcam and reload the page.");
    }
    if (name === "NotReadableError") {
      throw new CameraError("The camera is busy in another app (Teams, Zoom, Camera...). Close it and reload the page.");
    }
    throw new CameraError(`Could not start the camera (${name}).`);
  }
  video.srcObject = stream;
  await video.play();
  if (!video.videoWidth) await new Promise((r) => video.addEventListener("loadedmetadata", r, { once: true }));
}
