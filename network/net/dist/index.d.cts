import net, { Server } from 'net';
import { EventEmitter } from 'events';
import { Socket } from 'dgram';

interface Logger {
    log: (entry: {
        type: number;
        msg: string;
    }) => void;
}
interface PiperStats {
    rejectCnt?: number;
    locCnt?: number;
    remCnt?: number;
}
interface PiperOptions {
    logger?: Logger;
    onDestroy?: (err?: Error) => void;
    isServer?: boolean;
    compress?: boolean;
}
interface UdpSocketOptions {
    host: string;
    port: number;
    bind?: boolean;
    logger?: Logger;
}
declare function connPiper(connection: net.Socket, _dst: () => net.Socket | null, opts?: PiperOptions, stats?: PiperStats): void;
declare class UdpSocket {
    opts: UdpSocketOptions;
    logger: Logger;
    server: Socket;
    client: Socket;
    event: EventEmitter;
    rinfo: {
        address: string;
        port: number;
    } | null;
    constructor(opts: UdpSocketOptions);
    connect(): void;
    write(msg: Buffer): void;
}
interface UdpConnPiperOptions {
    client?: boolean;
    retryDelay?: number;
    logger?: Logger;
}
declare class UdpConnPiper {
    opts: UdpConnPiperOptions;
    logger: Logger;
    remote: net.Socket | (() => net.Socket | null);
    local: UdpSocket | (() => UdpSocket | null);
    client: boolean | undefined;
    retryDelay: number;
    destroyed: boolean;
    localStream: UdpSocket | null;
    remoteStream: net.Socket | null;
    bound: {
        onLocMessage: (msg: Buffer, rinfo: {
            address: string;
            port: number;
        }) => void;
        onConnectionMessage: (msg: Buffer) => void;
        onLocError: (err?: Error) => void;
        onLocClose: (err?: Error) => void;
        onConnectionError: (err?: Error) => void;
        onConnectionClose: (err?: Error) => void;
    };
    constructor(remote: net.Socket | (() => net.Socket | null), local: UdpSocket | (() => UdpSocket | null), opts?: UdpConnPiperOptions);
    connect(): void;
    attachListeners(): void;
    removeListeners(): void;
    onLocMessage(msg: Buffer, rinfo: {
        address: string;
        port: number;
    }): void;
    onConnectionMessage(msg: Buffer): void;
    _handleError(err?: Error): void;
    destroy(err?: Error): void;
}
declare function udpConnect(opts: UdpSocketOptions, callback?: (socket: UdpSocket) => void): UdpSocket | undefined;
declare function udpPiper(connection: net.Socket, _dst: UdpSocket | (() => UdpSocket | null), opts?: UdpConnPiperOptions): UdpConnPiper;
interface ListenOptions {
    port: number;
    host: string;
}
declare function createTcpProxy(listenOpts: ListenOptions, connectRemote: () => net.Socket | null, piperOpts?: PiperOptions, stats?: PiperStats, onListen?: () => void): Server;
declare function pipeTcpServer(remoteStream: net.Socket, localOpts: ListenOptions, piperOpts?: PiperOptions, stats?: PiperStats): void;
interface FramedProxyResult {
    proxySocket: Socket;
    clients: Map<string, FramedClient>;
}
interface FramedClient {
    remoteStream: net.Socket;
    rinfo: {
        address: string;
        port: number;
    };
    buffer: Buffer;
}
declare function createUdpFramedProxy(listenOpts: ListenOptions, connectRemote: () => net.Socket, logger: Logger, onBind?: () => void): FramedProxyResult;
declare function pipeUdpFramedServer(remoteStream: net.Socket, localOpts: ListenOptions, logger: Logger, _stats?: PiperStats): void;

export { type FramedClient, type FramedProxyResult, type ListenOptions, type Logger, type PiperOptions, type PiperStats, UdpConnPiper, type UdpConnPiperOptions, UdpSocket, type UdpSocketOptions, connPiper, createTcpProxy, createUdpFramedProxy, pipeTcpServer, pipeUdpFramedServer, udpConnect, udpPiper };
