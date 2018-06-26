import { Injectable } from '@angular/core';
import { jid as parseJid } from '@xmpp/jid';
import { x as xml } from '@xmpp/xml';
import { BehaviorSubject, Subject } from 'rxjs';
import { filter } from 'rxjs/operators';

import { ChatPlugin, Contact, Direction, LogInRequest, MessageWithBodyStanza, Stanza } from '../../../core';
import { ChatService } from '../../chat-service';
import { ContactFactoryService } from '../../contact-factory.service';
import { LogService } from '../../log.service';
import { MessageArchivePlugin, StanzaUuidPlugin } from './plugins';
import { RosterPlugin } from './plugins/roster.plugin';
import { XmppChatConnectionService } from './xmpp-chat-connection.service';

@Injectable()
export class XmppChatAdapter implements ChatService {

    message$ = new Subject<Contact>();
    contacts$ = new BehaviorSubject<Contact[]>([]);
    state$ = new BehaviorSubject<'disconnected' | 'connecting' | 'online'>('disconnected');
    private logInRequest: LogInRequest;
    private plugins: ChatPlugin[] = [];
    private rosterPlugin: RosterPlugin;

    constructor(public chatConnectionService: XmppChatConnectionService,
                private logService: LogService,
                private contactFactory: ContactFactoryService) {
        this.initializePlugins();
        chatConnectionService.state$
            .pipe(filter(state => state === 'online'))
            .subscribe(() => {
                Promise.all(this.plugins.map(plugin => plugin.onBeforeOnline()))
                    .then(
                        () => this.state$.next('online'),
                        () => this.state$.next('online')
                    );
            });
        this.chatConnectionService.stanzaPresenceRequest$.subscribe((stanza) => this.onContactPresenceRequest(stanza));
        this.chatConnectionService.stanzaPresenceInformation$.subscribe((stanza) => this.onContactPresenceInformation(stanza));
        this.chatConnectionService.stanzaMessage$.subscribe((stanza) => this.onMessageReceived(stanza));
        this.chatConnectionService.stanzaUnknown$.subscribe((stanza) => this.onUnknownStanza(stanza));
    }

    private initializePlugins() {
        this.rosterPlugin = new RosterPlugin(this, this.contactFactory);
        this.plugins = [new MessageArchivePlugin(this), new StanzaUuidPlugin(), this.rosterPlugin];
    }

    setContacts(newContacts: Contact[]) {

        const contactsByJid = {};
        const existingContacts = [].concat(this.contacts$.getValue()) as Contact[];
        let contactsDiffer = existingContacts.length !== newContacts.length;

        for (const newContact of newContacts) {
            contactsByJid[newContact.jidBare.toString()] = newContact;
        }

        for (const existingContact of existingContacts) {
            if (contactsByJid[existingContact.jidBare.toString()]) {
                contactsByJid[existingContact.jidBare.toString()] = existingContact;
            } else {
                contactsDiffer = true;
            }
        }

        if (contactsDiffer) {
            const nextContacts = [];
            for (const jid in contactsByJid) {
                if (contactsByJid.hasOwnProperty(jid)) {
                    nextContacts.push(contactsByJid[jid]);
                }
            }

            this.contacts$.next(nextContacts);
        }

    }

    reloadContacts(): void {
        this.rosterPlugin.refreshRosterContacts();
    }

    getContactByJid(jidPlain: string) {
        const bareJidToFind = parseJid(jidPlain).bare();
        return this.contacts$.getValue().find(contact => contact.jidBare.equals(bareJidToFind));
    }

    addContact(identifier: string) {
        this.rosterPlugin.addRosterContact(identifier);
    }

    removeContact(identifier: string) {
        this.rosterPlugin.removeRosterContact(identifier);
    }

    logIn(logInRequest: LogInRequest): void {
        this.logInRequest = logInRequest;
        this.chatConnectionService.logIn(logInRequest);
    }

    logOut(): void {
        this.setContacts([]);
        this.chatConnectionService.logOut();
    }

    sendMessage(jid: string, body: string) {
        const messageStanza = xml('message', {to: jid, from: this.chatConnectionService.myJidWithResource, type: 'chat'},
            xml('body', {}, body)
        );
        for (const plugin of this.plugins) {
            plugin.beforeSendMessage(messageStanza);
        }
        this.chatConnectionService.send(messageStanza).then(() => {
            const contact = this.getContactByJid(jid);
            if (contact) {
                const message = {
                    direction: Direction.out,
                    body,
                    datetime: new Date()
                };
                for (const plugin of this.plugins) {
                    plugin.afterSendMessage(message, messageStanza);
                }
                contact.appendMessage(message);
            }
        }, (rej) => {
            this.logService.error('rejected', rej);
        });
    }

    private onMessageReceived(messageStanza: MessageWithBodyStanza) {
        this.logService.debug('message received <=', messageStanza.getChildText('body'));
        const contact = this.getContactByJid(messageStanza.attrs.from);

        if (contact) {

            const message = {
                body: messageStanza.getChildText('body'),
                direction: Direction.in,
                datetime: new Date()
            };

            for (const plugin of this.plugins) {
                plugin.afterReceiveMessage(message, messageStanza);
            }

            contact.appendMessage(message);
            this.message$.next(contact);

        }
    }

    private onContactPresenceRequest(stanza: Stanza) {
        this.chatConnectionService.send(
            xml('presence', {to: stanza.attrs.from, type: 'subscribed'})
        );
    }

    private onContactPresenceInformation(stanza: Stanza) {
        if (stanza.getChild('show') != null) {
            // https://xmpp.org/rfcs/rfc3921.html#stanzas-presence-children-show
            const show = stanza.getChildText('show');
            if (show === 'away') {
                // away
                this.logService.debug('presence of', stanza.attrs.from, 'away');
            } else if (show === 'chat') {
                // chat
                this.logService.debug('presence of', stanza.attrs.from, 'chat');
            } else if (show === 'dnd') {
                // do not distrb
                this.logService.debug('presence of', stanza.attrs.from, 'dnd');
            } else if (show === 'xa') {
                // long away
                this.logService.debug('presence of', stanza.attrs.from, 'xa');
            } else {
                // error, undefined
            }
        } else {
            // contact available
            this.logService.debug('presence of', stanza.attrs.from, 'available');
        }
    }

    private onUnknownStanza(stanza: Stanza) {

        let handled = false;

        for (const plugin of this.plugins) {
            if (plugin.handleStanza(stanza)) {
                handled = true;
            }
        }

        if (!handled) {
            this.logService.warn('unknown stanza <=', stanza.toString());
        }

    }
}
