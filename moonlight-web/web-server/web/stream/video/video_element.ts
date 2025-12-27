import { emptyVideoCodecs, maybeVideoCodecs, VIDEO_DECODER_CODECS, VideoCodecSupport } from "../video.js";
import { getStreamRectCorrected, TrackVideoRenderer, VideoRendererInfo, VideoRendererSetup } from "./index.js";

function detectCodecs(): VideoCodecSupport {
    if (!("canPlayType" in HTMLVideoElement.prototype)) {
        return maybeVideoCodecs()
    }

    const codecs = emptyVideoCodecs()

    const testElement = document.createElement("video")

    for (const codec in codecs) {
        const supported = testElement.canPlayType(`video/mp4; codecs=${VIDEO_DECODER_CODECS[codec]}`)

        if (supported == "probably") {
            codecs[codec] = true
        } else if (supported == "maybe") {
            codecs[codec] = "maybe"
        } else {
            // unsupported
            codecs[codec] = false
        }
    }

    return codecs
}

export class VideoElementRenderer extends TrackVideoRenderer {
    static async getInfo(): Promise<VideoRendererInfo> {
        const supported = "HTMLVideoElement" in window && "srcObject" in HTMLVideoElement.prototype

        return {
            executionEnvironment: {
                main: supported,
                worker: false
            },
            supportedCodecs: supported ? detectCodecs() : emptyVideoCodecs()
        }
    }

    private videoElement = document.createElement("video")
    private oldTrack: MediaStreamTrack | null = null
    private stream = new MediaStream()

    private size: [number, number] | null = null

    constructor() {
        super("video_element")

        this.videoElement.classList.add("video-stream")
        this.videoElement.preload = "none"
        this.videoElement.controls = false
        this.videoElement.autoplay = true
        this.videoElement.disablePictureInPicture = true
        this.videoElement.playsInline = true
        this.videoElement.muted = true

        if ("srcObject" in this.videoElement) {
            try {
                this.videoElement.srcObject = this.stream
            } catch (err: any) {
                if (err.name !== "TypeError") {
                    throw err;
                }

                console.error(err)
                throw `video_element renderer not supported: ${err}`
            }
        }
    }

    async setup(setup: VideoRendererSetup): Promise<void> {
        this.size = [setup.width, setup.height]
    }
    cleanup(): void {
        if (this.oldTrack) {
            this.stream.removeTrack(this.oldTrack)
        }
        this.videoElement.srcObject = null
    }

    setTrack(track: MediaStreamTrack): void {
        if (this.oldTrack) {
            this.stream.removeTrack(this.oldTrack)
        }

        this.stream.addTrack(track)
        this.oldTrack = track
    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.videoElement)
    }
    unmount(parent: HTMLElement): void {
        parent.removeChild(this.videoElement)
    }

    onUserInteraction(): void {
        if (this.videoElement.paused) {
            this.videoElement.play().then(() => {
                // Playing
            }).catch(error => {
                console.error(`Failed to play videoElement: ${error.message || error}`);
            })
        }
    }
    getStreamRect(): DOMRect {
        if (!this.size) {
            return new DOMRect()
        }

        return getStreamRectCorrected(this.videoElement.getBoundingClientRect(), this.size)
    }
}