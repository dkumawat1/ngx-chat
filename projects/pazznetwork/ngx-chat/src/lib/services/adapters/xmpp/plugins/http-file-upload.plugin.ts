import { HttpClient } from '@angular/common/http';
import { x as xml } from '@xmpp/xml';
import { XmppChatAdapter } from '../xmpp-chat-adapter.service';
import { AbstractXmppPlugin } from './abstract-xmpp-plugin';
import { Service, ServiceDiscoveryPlugin } from './service-discovery.plugin';

/**
 * XEP-0363 http file upload
 */
export class HttpFileUploadPlugin extends AbstractXmppPlugin {

    private uploadService: Promise<Service>;

    constructor(
        private httpClient: HttpClient,
        private serviceDiscoveryPlugin: ServiceDiscoveryPlugin,
        private xmppChatAdapter: XmppChatAdapter,
    ) {
        super();
    }

    onBeforeOnline(): PromiseLike<any> {
        this.uploadService = this.serviceDiscoveryPlugin.findService('store', 'file');
        return Promise.resolve();
    }

    onOffline() {
        this.uploadService = null;
    }

    async upload(file: File) {
        await this.uploadService;
        const {name, size, type} = file;
        const slotUrl = await this.requestSlot(name, size.toString(), type);
        return this.uploadToSlot(slotUrl, file);
    }

    private async requestSlot(filename: string, size: string, contentType: string) {
        const to = (await this.uploadService).jid;
        const slotResponse = await this.xmppChatAdapter.chatConnectionService.sendIq(
            xml('iq', {to, type: 'get'},
                xml('request', {xmlns: 'urn:xmpp:http:upload:0', filename, size, 'content-type': contentType})));
        return slotResponse.getChild('slot').getChild('put').attrs.url;
    }

    private async uploadToSlot(slot: string, file: File): Promise<string> {
        await this.httpClient.put(slot, file, {responseType: 'blob'}).toPromise();
        return slot;
    }

}
