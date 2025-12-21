
// TODO: add explanation for a big text which will be the main focus to explain why the connection / decoder might not be found and what can be done about it
export type LogMessageType = "fatal" | "recover"
export type LogMessageInfo = {
    type?: LogMessageType
}

export type LogListener = (fullRawText: string, type: LogMessageType | null) => void

export class Logger {

    constructor() { }

    debug(message: string, info?: LogMessageInfo) {
        this.callListeners(message, info?.type)
    }

    private callListeners(message: string, type?: LogMessageType) {
        for (const listener of this.infoListeners) {
            listener(message, type ?? null)
        }
    }

    private infoListeners: Array<LogListener> = []
    addInfoListener(listener: LogListener) {
        this.infoListeners.push(listener)
    }
    removeInfoListener(listener: LogListener) {
        const index = this.infoListeners.indexOf(listener)
        if (index != -1) {
            this.infoListeners.splice(index, 1)
        }
    }
}