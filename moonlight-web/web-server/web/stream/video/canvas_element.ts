import { allVideoCodecs } from "../video.js"
import { FrameVideoRenderer, getStreamRectCorrected, VideoRendererInfo, VideoRendererSetup } from "./index.js"

export class CanvasVideoRenderer extends FrameVideoRenderer {

    static async getInfo(): Promise<VideoRendererInfo> {
        // no link
        return {
            executionEnvironment: {
                main: "HTMLCanvasElement" in window && "CanvasRenderingContext2D" in window,
                worker: false
            },
            supportedCodecs: allVideoCodecs()
        }
    }

    private canvas: HTMLCanvasElement = document.createElement("canvas")
    private context: CanvasRenderingContext2D | null = null
    private currentFrame: VideoFrame | null = null

    private animationFrameRequest: number | null = null

    private videoSize: [number, number] | null = null

    constructor() {
        super("canvas_element")

        this.canvas.classList.add("video-stream")
    }

    async setup(setup: VideoRendererSetup): Promise<void> {
        this.videoSize = [setup.width, setup.height]

        if (this.animationFrameRequest == null) {
            this.animationFrameRequest = requestAnimationFrame(this.onAnimationFrame.bind(this))
        }
    }

    cleanup(): void {
        this.context = null

        if (this.animationFrameRequest != null) {
            cancelAnimationFrame(this.animationFrameRequest)
            this.animationFrameRequest = null
        }
    }

    submitFrame(frame: VideoFrame): void {
        this.currentFrame?.close()

        this.currentFrame = frame
    }

    private onAnimationFrame() {
        const frame = this.currentFrame

        if (frame && this.context) {
            // Calculate aspect ratios
            const canvasAspect = this.canvas.clientWidth / this.canvas.clientHeight
            const frameAspect = frame.displayWidth / frame.displayHeight

            let drawWidth
            let drawHeight
            let offsetX = 0
            let offsetY = 0

            // Adjust canvas rendering resolution to match the video frame's intrinsic resolution
            // This ensures that the image data drawn onto the canvas has the correct pixel density
            // and avoids blurriness that can occur if the canvas's internal resolution
            // is different from the source video frame's resolution.
            this.canvas.width = frame.displayWidth
            this.canvas.height = frame.displayHeight

            if (canvasAspect > frameAspect) {
                // Canvas is wider than the video frame, so the video will be pillarboxed.
                drawHeight = this.canvas.height
                drawWidth = drawHeight * frameAspect
                offsetX = (this.canvas.width - drawWidth) / 2
            } else {
                // Canvas is taller than the video frame, so the video will be letterboxed.
                drawWidth = this.canvas.width
                drawHeight = drawWidth / frameAspect
                offsetY = (this.canvas.height - drawHeight) / 2
            }

            // Clear the canvas before drawing the new frame to prevent artifacts
            this.context.clearRect(0, 0, this.canvas.width, this.canvas.height)
            this.context.drawImage(frame, offsetX, offsetY, drawWidth, drawHeight)
        }

        this.animationFrameRequest = requestAnimationFrame(this.onAnimationFrame.bind(this))
    }

    onUserInteraction(): void {
        // Nothing
    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.canvas)

        if (!this.context) {
            const context = this.canvas.getContext("2d")
            if (context) {
                this.context = context
            } else {
                throw "Failed to get 2d context from canvas"
            }
        }
    }
    unmount(parent: HTMLElement): void {
        parent.removeChild(this.canvas)
    }

    getStreamRect(): DOMRect {
        if (!this.videoSize) {
            return new DOMRect()
        }

        return getStreamRectCorrected(this.canvas.getBoundingClientRect(), this.videoSize)
    }
}