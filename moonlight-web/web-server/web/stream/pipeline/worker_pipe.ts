import { ExecutionEnvironment } from "../index.js";
import { TrackVideoRenderer, VideoRenderer, VideoRendererSetup } from "../video/index.js";
import { ToMainMessage, ToWorkerMessage } from "./worker_types.js";

export function createPipelineWorker(): Worker {
    return new Worker(new URL("worker.js", import.meta.url), { type: "module" })
}

function checkWorkerSupport(className: string): Promise<boolean> {

    return new Promise((resolve, reject) => {
        const worker = createPipelineWorker()

        worker.onerror = reject
        worker.onmessageerror = reject

        worker.onmessage = (message) => {
            const data = message.data as ToMainMessage

            resolve(data.checkSupport.supported)
        }

        const request: ToWorkerMessage = {
            checkSupport: { className }
        }
        worker.postMessage(request)
    });
}

export async function checkExecutionEnvironment(className: string): Promise<ExecutionEnvironment> {
    return {
        main: className in window,
        worker: await checkWorkerSupport(className),
    }
}

export class WorkerPipeline {

    private worker: Worker

    constructor() {
        this.worker = createPipelineWorker()
    }
}

export class WorkerDataInput extends VideoRenderer {
    async setup(setup: VideoRendererSetup): Promise<void> {
        throw new Error("Method not implemented.");
    }
    cleanup(): void {
        throw new Error("Method not implemented.");
    }
    onUserInteraction(): void {
        throw new Error("Method not implemented.");
    }
    getStreamRect(): DOMRect {
        throw new Error("Method not implemented.");
    }
    mount(parent: HTMLElement): void {
        throw new Error("Method not implemented.");
    }
    unmount(parent: HTMLElement): void {
        throw new Error("Method not implemented.");
    }
}

export abstract class WorkerOutput<T extends VideoRenderer> extends VideoRenderer {
    static readonly type: string = "worker"
}

export function createWorkerPipe(input: "data", base: TrackVideoRenderer): void

export function createWorkerPipe(input: string, base: VideoRenderer) { }