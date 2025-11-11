import { App, DeleteHostQuery, DeleteUserRequest, DetailedHost, DetailedUser, GetAppImageQuery, GetAppsQuery, GetAppsResponse, GetHostQuery, GetHostResponse, GetHostsResponse, GetUserQuery, GetUsersResponse, PatchUserRequest, PostCancelRequest, PostCancelResponse, PostLoginRequest, PostPairRequest, PostPairResponse1, PostPairResponse2, PostUserRequest, PostWakeUpRequest, PutHostRequest, PutHostResponse, UndetailedHost } from "./api_bindings.js";
import { showErrorPopup } from "./component/error.js";
import { showMessage, showModal } from "./component/modal/index.js";
import { ApiUserPasswordPrompt } from "./component/modal/login.js";
import { buildUrl, isUserPasswordAuthenticationEnabled } from "./config_.js";

// IMPORTANT: this should be a bit bigger than the moonlight-common reqwest backend timeout if some hosts are offline!
const API_TIMEOUT = 12000

let currentApi: Api | null = null

// -- Any errors related to auth will reload page -> show the auth modal
function handleError(event: ErrorEvent) {
    onError(event.error)
}
function handleRejection(event: PromiseRejectionEvent) {
    onError(event.reason)
}
function onError(error: any) {
    if (error instanceof FetchError) {
        const response = error.getResponse()
        // 401 = Unauthorized
        if (response?.status == 401) {
            window.location.reload()
        }
    }
}

window.addEventListener("error", handleError)
window.addEventListener("unhandledrejection", handleRejection)

export async function getApi(host_url?: string): Promise<Api> {
    if (currentApi) {
        return currentApi
    }

    if (!host_url) {
        host_url = buildUrl("/api")
    }

    let api = { host_url, bearer: null }

    const authenticated = await apiAuthenticate(api)

    if (isUserPasswordAuthenticationEnabled() && !authenticated) {
        while (true) {
            const prompt = new ApiUserPasswordPrompt()
            const userAuth = await showModal(prompt)

            if (userAuth == null) {
                continue;
            }

            if (await apiLogin(api, userAuth)) {
                if (!await apiAuthenticate(api)) {
                    showErrorPopup("Login was successful but authentication doesn't work!")
                }
                break
            }

            await showMessage("Credentials are not Valid")
        }
    }

    currentApi = { host_url, bearer: null }

    return currentApi
}

const GET = "GET"
const POST = "POST"
const PATCH = "PATCH"
const DELETE = "DELETE"

export type Api = {
    host_url: string
    bearer: string | null,
}

export type ApiFetchInit = {
    json?: any,
    query?: any,
    noTimeout?: boolean,
}

export function isDetailedHost(host: UndetailedHost | DetailedHost): host is DetailedHost {
    return (host as DetailedHost).https_port !== undefined
}

function buildRequest(api: Api, endpoint: string, method: string, init?: ApiFetchInit): [string, RequestInit] {
    // Remove all null values from query, these cause problems in rust
    if (init?.query != null) {
        for (const key in init?.query) {
            if (init.query[key] === null) {
                delete init.query[key]
            }
        }
    }

    const query = new URLSearchParams(init?.query)
    const queryString = query.size > 0 ? `?${query.toString()}` : "";
    const url = `${api.host_url}${endpoint}${queryString}`

    const headers: any = {
    };

    if (isUserPasswordAuthenticationEnabled() && api.bearer) {
        headers["Authorization"] = `Bearer ${api.bearer}`;
    }

    if (init?.json) {
        headers["Content-Type"] = "application/json";
    }

    const request: RequestInit = {
        method: method,
        headers,
        body: init?.json && JSON.stringify(init.json),
        credentials: "include"
    }

    return [url, request]
}

export class FetchError extends Error {
    private response?: Response

    constructor(type: "timeout", endpoint: string, method: string)
    constructor(type: "failed", endpoint: string, method: string, response: Response)
    constructor(type: "unknown", endpoint: string, method: string, error: Error)

    constructor(type: "timeout" | "failed" | "unknown", endpoint: string, method: string, responseOrError?: Response | any) {
        if (type == "timeout") {
            super(`failed to fetch ${method} at ${endpoint} because of timeout`)
        } else if (type == "failed") {
            const response = responseOrError as Response
            super(`failed to fetch ${method} at ${endpoint} with code ${response?.status}`)

            this.response = response
        } else if (type == "unknown") {
            const error = responseOrError as Error
            super(`failed to fetch ${method} at ${endpoint} because of ${error}`)
        }
    }

    getResponse(): Response | null {
        return this.response ?? null
    }
}

class StreamedJsonResponse<Initial, Other> {
    response: Initial

    private reader
    private decoder = new TextDecoder()
    private bufferedText = ""

    constructor(body: ReadableStreamDefaultReader, response: Initial) {
        this.reader = body
        this.response = response
    }

    async next(): Promise<Other | null> {
        while (true) {
            const { done, value } = await this.reader.read()

            if (done) {
                return null
            }

            this.bufferedText += this.decoder.decode(value)

            const split = this.bufferedText.split("\n", 2)
            if (split.length == 2) {
                this.bufferedText = split[1]

                const text = split[0]
                const json = JSON.parse(text)

                return json
            }
        }
    }
}

export async function fetchApi(api: Api, endpoint: string, method: string, init?: { response?: "json" } & ApiFetchInit): Promise<any>
export async function fetchApi(api: Api, endpoint: string, method: string, init: { response: "ignore" } & ApiFetchInit): Promise<Response>
export async function fetchApi<Initial, Other>(api: Api, endpoint: string, method: string, init: { response: "jsonStreaming" } & ApiFetchInit): Promise<StreamedJsonResponse<Initial, Other>>

export async function fetchApi(api: Api, endpoint: string, method: string = GET, init?: { response?: "json" | "ignore" | "jsonStreaming" } & ApiFetchInit) {
    const [url, request] = buildRequest(api, endpoint, method, init)

    const timeoutAbort = new AbortController()
    request.signal = timeoutAbort.signal
    if (!init?.noTimeout) {
        setTimeout(() => timeoutAbort.abort(
            new FetchError("timeout", endpoint, method)
        ), API_TIMEOUT)
    }

    let response
    try {
        response = await fetch(url, request)
    } catch (e: any) {
        throw new FetchError("unknown", endpoint, method, e)
    }

    if (!response.ok) {
        throw new FetchError("failed", endpoint, method, response)
    }

    if (init?.response == "ignore") {
        return response
    }

    if (init?.response == undefined || init.response == "json") {
        const json = await response.json()

        return json
    } else if (init?.response == "jsonStreaming") {
        if (!response.body) {
            // TODO: error
            throw "TODO"
        }

        // @ts-ignore
        const stream = new StreamedJsonResponse(response.body?.getReader())
        const data = await stream.next()
        stream.response = data

        return stream
    }
}

export async function apiLogin(api: Api, request: PostLoginRequest): Promise<boolean> {
    let response

    try {
        response = await fetchApi(api, "/login", "post", {
            json: request,
            response: "ignore"
        })
    } catch (e) {
        if (e instanceof FetchError) {
            const response = e.getResponse()

            if (response && (response.status == 401 || response.status == 404)) {
                return false
            } else {
                showErrorPopup(e.message)
                return false
            }
        }
    }

    return true
}

export async function apiLogout(api: Api): Promise<boolean> {
    let response
    try {
        response = await fetchApi(api, "/logout", "post", { response: "ignore" })
    } catch (e) {
        throw e
    }

    return true
}

export async function apiAuthenticate(api: Api): Promise<boolean> {
    let response
    try {
        response = await fetchApi(api, "/authenticate", GET, { response: "ignore" })
    } catch (e) {
        if (e instanceof FetchError) {
            const response = e.getResponse()
            if (response && response.status == 401) {
                return false
            } else {
                throw e
            }
        }
        throw e
    }

    return response != null
}

export async function apiGetUser(api: Api, query: GetUserQuery): Promise<DetailedUser> {
    const response = await fetchApi(api, "/user", GET, { query })

    return response as DetailedUser
}
export async function apiGetUsers(api: Api): Promise<GetUsersResponse> {
    const response = await fetchApi(api, "/users", GET)

    return response as GetUsersResponse
}
export async function apiPostUser(api: Api, data: PostUserRequest): Promise<DetailedUser> {
    const response = await fetchApi(api, "/user", POST, { json: data })

    return response as DetailedUser
}
export async function apiPatchUser(api: Api, data: PatchUserRequest): Promise<void> {
    await fetchApi(api, "/user", PATCH, {
        json: data,
        response: "ignore"
    })
}
export async function apiDeleteUser(api: Api, data: DeleteUserRequest): Promise<void> {
    await fetchApi(api, "/user", DELETE, {
        json: data,
        response: "ignore"
    })
}

export async function apiGetHosts(api: Api): Promise<StreamedJsonResponse<GetHostsResponse, UndetailedHost>> {
    return await fetchApi<GetHostsResponse, UndetailedHost>(api, "/hosts", GET, { response: "jsonStreaming" })
}
export async function apiGetHost(api: Api, query: GetHostQuery): Promise<DetailedHost> {
    const response = await fetchApi(api, "/host", GET, { query })

    return (response as GetHostResponse).host
}
export async function apiPostHost(api: Api, data: PutHostRequest): Promise<DetailedHost> {
    const response = await fetchApi(api, "/host", "post", { json: data })

    return (response as PutHostResponse).host
}
export async function apiDeleteHost(api: Api, query: DeleteHostQuery): Promise<void> {
    await fetchApi(api, "/host", "delete", { query, response: "ignore" })
}

export async function apiPostPair(api: Api, request: PostPairRequest): Promise<StreamedJsonResponse<PostPairResponse1, PostPairResponse2>> {
    return await fetchApi(api, "/pair", "post", {
        json: request,
        response: "jsonStreaming",
        noTimeout: true
    })
}

export async function apiWakeUp(api: Api, request: PostWakeUpRequest): Promise<void> {
    await fetchApi(api, "/host/wake", "post", {
        json: request,
        response: "ignore"
    })
}

export async function apiGetApps(api: Api, query: GetAppsQuery): Promise<Array<App>> {
    const response = await fetchApi(api, "/apps", GET, { query }) as GetAppsResponse

    return response.apps
}

export async function apiGetAppImage(api: Api, query: GetAppImageQuery): Promise<Blob> {
    const response = await fetchApi(api, "/app/image", GET, {
        query,
        response: "ignore"
    })

    return await response.blob()
}

export async function apiHostCancel(api: Api, request: PostCancelRequest): Promise<PostCancelResponse> {
    const response = await fetchApi(api, "/host/cancel", POST, {
        json: request
    })

    return response as PostCancelResponse
}