import { Component } from "../../component/index.js"
import { StreamSupportedVideoFormats } from "../../api_bindings.js"

export type VideoRendererSetup = {
    format: keyof typeof StreamSupportedVideoFormats,
    width: number
    height: number
    fps: number
}

export abstract class VideoRenderer implements Component {
    readonly implementationName: string

    constructor(implementationName: string) {
        this.implementationName = implementationName
    }

    /// Returns the success
    abstract setup(setup: VideoRendererSetup): void
    abstract cleanup(): void

    abstract onUserInteraction(): void
    abstract getStreamRect(): DOMRect

    abstract mount(parent: HTMLElement): void
    abstract unmount(parent: HTMLElement): void
}

export function getStreamRectCorrected(boundingRect: DOMRect, videoSize: [number, number]): DOMRect {
    const videoAspect = videoSize[0] / videoSize[1]

    const boundingRectAspect = boundingRect.width / boundingRect.height

    let x = boundingRect.x
    let y = boundingRect.y
    let videoMultiplier
    if (boundingRectAspect > videoAspect) {
        // How much is the video scaled up
        videoMultiplier = boundingRect.height / videoSize[1]

        // Note: Both in boundingRect / page scale
        const boundingRectHalfWidth = boundingRect.width / 2
        const videoHalfWidth = videoSize[0] * videoMultiplier / 2

        x += boundingRectHalfWidth - videoHalfWidth
    } else {
        // Same as above but inverted
        videoMultiplier = boundingRect.width / videoSize[0]

        const boundingRectHalfHeight = boundingRect.height / 2
        const videoHalfHeight = videoSize[1] * videoMultiplier / 2

        y += boundingRectHalfHeight - videoHalfHeight
    }

    return new DOMRect(
        x,
        y,
        videoSize[0] * videoMultiplier,
        videoSize[1] * videoMultiplier
    )
}

export abstract class TrackVideoRenderer extends VideoRenderer {
    static readonly type: string = "videotrack"

    abstract setTrack(track: MediaStreamTrack): void
}

export type VideoDecodeUnit = {
    type: "key" | "delta"
    timestampMicroseconds: number
    durationMicroseconds: number
    data: ArrayBuffer
}

export abstract class DataVideoRenderer extends VideoRenderer {
    static readonly type: string = "data"

    /// Data like https://github.com/moonlight-stream/moonlight-common-c/blob/b126e481a195fdc7152d211def17190e3434bcce/src/Limelight.h#L298
    abstract submitDecodeUnit(unit: VideoDecodeUnit): void
}

export abstract class FrameVideoRenderer extends VideoRenderer {
    static readonly type: string = "videoframe"

    /// Submits a frame. This renderer now "owns" the frame and needs to clean it up via close.
    abstract submitFrame(frame: VideoFrame): void
}
