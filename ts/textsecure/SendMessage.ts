// tslint:disable no-bitwise no-default-export

import { Dictionary, without } from 'lodash';
import PQueue from 'p-queue';

import {
  GroupCredentialsType,
  GroupLogResponseType,
  ProxiedRequestOptionsType,
  WebAPIType,
} from './WebAPI';
import createTaskWithTimeout from './TaskWithTimeout';
import OutgoingMessage from './OutgoingMessage';
import Crypto from './Crypto';
import {
  base64ToArrayBuffer,
  concatenateBytes,
  fromEncodedBinaryToArrayBuffer,
  getZeroes,
  hexToArrayBuffer,
} from '../Crypto';
import {
  AttachmentPointerClass,
  CallingMessageClass,
  ContentClass,
  DataMessageClass,
  GroupChangeClass,
  GroupClass,
  StorageServiceCallOptionsType,
  StorageServiceCredentials,
} from '../textsecure.d';
import { MessageError, SignedPreKeyRotationError } from './Errors';

function stringToArrayBuffer(str: string): ArrayBuffer {
  if (typeof str !== 'string') {
    throw new Error('Passed non-string to stringToArrayBuffer');
  }
  const res = new ArrayBuffer(str.length);
  const uint = new Uint8Array(res);
  for (let i = 0; i < str.length; i += 1) {
    uint[i] = str.charCodeAt(i);
  }
  return res;
}

export type SendMetadataType = {
  [identifier: string]: {
    accessKey: string;
  };
};

export type SendOptionsType = {
  senderCertificate?: ArrayBuffer;
  sendMetadata?: SendMetadataType;
  online?: boolean;
};

export type CallbackResultType = {
  successfulIdentifiers?: Array<any>;
  failoverIdentifiers?: Array<any>;
  errors?: Array<any>;
  unidentifiedDeliveries?: Array<any>;
  dataMessage?: ArrayBuffer;
  discoveredIdentifierPairs: Array<{
    e164: string;
    uuid: string | null;
  }>;
};

type PreviewType = {
  url: string;
  title: string;
  image: AttachmentType;
};

type QuoteAttachmentType = {
  thumbnail?: AttachmentType;
  attachmentPointer?: AttachmentPointerClass;
};

type GroupV2InfoType = {
  groupChange?: ArrayBuffer;
  masterKey: ArrayBuffer;
  revision: number;
  members: Array<string>;
};
type GroupV1InfoType = {
  id: string;
  members: Array<string>;
};

type MessageOptionsType = {
  attachments?: Array<AttachmentType> | null;
  body?: string;
  expireTimer?: number;
  flags?: number;
  group?: {
    id: string;
    type: number;
  };
  groupV2?: GroupV2InfoType;
  needsSync?: boolean;
  preview?: Array<PreviewType> | null;
  profileKey?: ArrayBuffer;
  quote?: any;
  recipients: Array<string>;
  sticker?: any;
  reaction?: any;
  timestamp: number;
};

class Message {
  attachments: Array<any>;
  body?: string;
  expireTimer?: number;
  flags?: number;
  group?: {
    id: string;
    type: number;
  };
  groupV2?: GroupV2InfoType;
  needsSync?: boolean;
  preview: any;
  profileKey?: ArrayBuffer;
  quote?: any;
  recipients: Array<string>;
  sticker?: any;
  reaction?: any;
  timestamp: number;

  dataMessage: any;
  attachmentPointers?: Array<any>;

  // tslint:disable cyclomatic-complexity
  constructor(options: MessageOptionsType) {
    this.attachments = options.attachments || [];
    this.body = options.body;
    this.expireTimer = options.expireTimer;
    this.flags = options.flags;
    this.group = options.group;
    this.groupV2 = options.groupV2;
    this.needsSync = options.needsSync;
    this.preview = options.preview;
    this.profileKey = options.profileKey;
    this.quote = options.quote;
    this.recipients = options.recipients;
    this.sticker = options.sticker;
    this.reaction = options.reaction;
    this.timestamp = options.timestamp;

    if (!(this.recipients instanceof Array)) {
      throw new Error('Invalid recipient list');
    }

    if (!this.group && !this.groupV2 && this.recipients.length !== 1) {
      throw new Error('Invalid recipient list for non-group');
    }

    if (typeof this.timestamp !== 'number') {
      throw new Error('Invalid timestamp');
    }

    if (this.expireTimer !== undefined && this.expireTimer !== null) {
      if (typeof this.expireTimer !== 'number' || !(this.expireTimer >= 0)) {
        throw new Error('Invalid expireTimer');
      }
    }

    if (this.attachments) {
      if (!(this.attachments instanceof Array)) {
        throw new Error('Invalid message attachments');
      }
    }
    if (this.flags !== undefined) {
      if (typeof this.flags !== 'number') {
        throw new Error('Invalid message flags');
      }
    }
    if (this.isEndSession()) {
      if (
        this.body !== null ||
        this.group !== null ||
        this.attachments.length !== 0
      ) {
        throw new Error('Invalid end session message');
      }
    } else {
      if (
        typeof this.timestamp !== 'number' ||
        (this.body && typeof this.body !== 'string')
      ) {
        throw new Error('Invalid message body');
      }
      if (this.group) {
        if (
          typeof this.group.id !== 'string' ||
          typeof this.group.type !== 'number'
        ) {
          throw new Error('Invalid group context');
        }
      }
    }
  }

  isEndSession() {
    return (
      (this.flags || 0) &
      window.textsecure.protobuf.DataMessage.Flags.END_SESSION
    );
  }

  toProto(): DataMessageClass {
    if (this.dataMessage instanceof window.textsecure.protobuf.DataMessage) {
      return this.dataMessage;
    }
    const proto = new window.textsecure.protobuf.DataMessage();

    proto.timestamp = this.timestamp;
    proto.attachments = this.attachmentPointers;

    if (this.body) {
      proto.body = this.body;
    }
    if (this.flags) {
      proto.flags = this.flags;
    }
    if (this.groupV2) {
      proto.groupV2 = new window.textsecure.protobuf.GroupContextV2();
      proto.groupV2.masterKey = this.groupV2.masterKey;
      proto.groupV2.revision = this.groupV2.revision;
      proto.groupV2.groupChange = this.groupV2.groupChange || null;
    } else if (this.group) {
      proto.group = new window.textsecure.protobuf.GroupContext();
      proto.group.id = stringToArrayBuffer(this.group.id);
      proto.group.type = this.group.type;
    }
    if (this.sticker) {
      proto.sticker = new window.textsecure.protobuf.DataMessage.Sticker();
      proto.sticker.packId = hexToArrayBuffer(this.sticker.packId);
      proto.sticker.packKey = base64ToArrayBuffer(this.sticker.packKey);
      proto.sticker.stickerId = this.sticker.stickerId;

      if (this.sticker.attachmentPointer) {
        proto.sticker.data = this.sticker.attachmentPointer;
      }
    }
    if (this.reaction) {
      proto.reaction = this.reaction;
    }
    if (Array.isArray(this.preview)) {
      proto.preview = this.preview.map(preview => {
        const item = new window.textsecure.protobuf.DataMessage.Preview();
        item.title = preview.title;
        item.url = preview.url;
        item.image = preview.image || null;
        return item;
      });
    }
    if (this.quote) {
      const { QuotedAttachment } = window.textsecure.protobuf.DataMessage.Quote;
      const { Quote } = window.textsecure.protobuf.DataMessage;

      proto.quote = new Quote();
      const { quote } = proto;

      quote.id = this.quote.id;
      quote.author = this.quote.author;
      quote.text = this.quote.text;
      quote.attachments = (this.quote.attachments || []).map(
        (attachment: AttachmentType) => {
          const quotedAttachment = new QuotedAttachment();

          quotedAttachment.contentType = attachment.contentType;
          quotedAttachment.fileName = attachment.fileName;
          if (attachment.attachmentPointer) {
            quotedAttachment.thumbnail = attachment.attachmentPointer;
          }

          return quotedAttachment;
        }
      );
    }
    if (this.expireTimer) {
      proto.expireTimer = this.expireTimer;
    }
    if (this.profileKey) {
      proto.profileKey = this.profileKey;
    }

    this.dataMessage = proto;
    return proto;
  }

  toArrayBuffer() {
    return this.toProto().toArrayBuffer();
  }
}

export type AttachmentType = {
  size: number;
  data: ArrayBuffer;
  contentType: string;

  fileName: string;
  flags: number;
  width: number;
  height: number;
  caption: string;

  attachmentPointer?: AttachmentPointerClass;

  blurHash?: string;
};

export default class MessageSender {
  server: WebAPIType;
  pendingMessages: {
    [id: string]: PQueue;
  };

  constructor(username: string, password: string) {
    this.server = window.WebAPI.connect({ username, password });
    this.pendingMessages = {};
  }

  _getAttachmentSizeBucket(size: number) {
    return Math.max(
      541,
      Math.floor(1.05 ** Math.ceil(Math.log(size) / Math.log(1.05)))
    );
  }

  getPaddedAttachment(data: ArrayBuffer) {
    const size = data.byteLength;
    const paddedSize = this._getAttachmentSizeBucket(size);
    const padding = getZeroes(paddedSize - size);

    return concatenateBytes(data, padding);
  }

  async makeAttachmentPointer(attachment: AttachmentType) {
    if (typeof attachment !== 'object' || attachment == null) {
      return Promise.resolve(undefined);
    }

    const { data, size } = attachment;
    if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
      throw new Error(
        `makeAttachmentPointer: data was a '${typeof data}' instead of ArrayBuffer/ArrayBufferView`
      );
    }
    if (data.byteLength !== size) {
      throw new Error(
        `makeAttachmentPointer: Size ${size} did not match data.byteLength ${data.byteLength}`
      );
    }

    const padded = this.getPaddedAttachment(data);
    const key = window.libsignal.crypto.getRandomBytes(64);
    const iv = window.libsignal.crypto.getRandomBytes(16);

    const result = await Crypto.encryptAttachment(padded, key, iv);
    const id = await this.server.putAttachment(result.ciphertext);

    const proto = new window.textsecure.protobuf.AttachmentPointer();
    proto.cdnId = id;
    proto.contentType = attachment.contentType;
    proto.key = key;
    proto.size = attachment.size;
    proto.digest = result.digest;

    if (attachment.fileName) {
      proto.fileName = attachment.fileName;
    }
    if (attachment.flags) {
      proto.flags = attachment.flags;
    }
    if (attachment.width) {
      proto.width = attachment.width;
    }
    if (attachment.height) {
      proto.height = attachment.height;
    }
    if (attachment.caption) {
      proto.caption = attachment.caption;
    }
    if (attachment.blurHash) {
      proto.blurHash = attachment.blurHash;
    }

    return proto;
  }

  async queueJobForIdentifier(identifier: string, runJob: () => Promise<any>) {
    const { id } = await window.ConversationController.getOrCreateAndWait(
      identifier,
      'private'
    );
    this.pendingMessages[id] =
      this.pendingMessages[id] || new PQueue({ concurrency: 1 });

    const queue = this.pendingMessages[id];

    const taskWithTimeout = createTaskWithTimeout(
      runJob,
      `queueJobForIdentifier ${identifier} ${id}`
    );

    return queue.add(taskWithTimeout);
  }

  async uploadAttachments(message: Message) {
    return Promise.all(
      message.attachments.map(this.makeAttachmentPointer.bind(this))
    )
      .then(attachmentPointers => {
        // eslint-disable-next-line no-param-reassign
        message.attachmentPointers = attachmentPointers;
      })
      .catch(error => {
        if (error instanceof Error && error.name === 'HTTPError') {
          throw new MessageError(message, error);
        } else {
          throw error;
        }
      });
  }

  async uploadLinkPreviews(message: Message) {
    try {
      const preview = await Promise.all(
        (message.preview || []).map(async (item: PreviewType) => ({
          ...item,
          image: await this.makeAttachmentPointer(item.image),
        }))
      );
      // eslint-disable-next-line no-param-reassign
      message.preview = preview;
    } catch (error) {
      if (error instanceof Error && error.name === 'HTTPError') {
        throw new MessageError(message, error);
      } else {
        throw error;
      }
    }
  }

  async uploadSticker(message: Message) {
    try {
      const { sticker } = message;

      if (!sticker || !sticker.data) {
        return;
      }

      // eslint-disable-next-line no-param-reassign
      message.sticker = {
        ...sticker,
        attachmentPointer: await this.makeAttachmentPointer(sticker.data),
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'HTTPError') {
        throw new MessageError(message, error);
      } else {
        throw error;
      }
    }
  }

  async uploadThumbnails(message: Message): Promise<void> {
    const makePointer = this.makeAttachmentPointer.bind(this);
    const { quote } = message;

    if (!quote || !quote.attachments || quote.attachments.length === 0) {
      return Promise.resolve();
    }

    await Promise.all(
      quote.attachments.map((attachment: QuoteAttachmentType) => {
        if (!attachment.thumbnail) {
          return null;
        }

        return makePointer(attachment.thumbnail).then(pointer => {
          // eslint-disable-next-line no-param-reassign
          attachment.attachmentPointer = pointer;
        });
      })
    ).catch(error => {
      if (error instanceof Error && error.name === 'HTTPError') {
        throw new MessageError(message, error);
      } else {
        throw error;
      }
    });
  }

  async sendMessage(
    attrs: MessageOptionsType,
    options?: SendOptionsType
  ): Promise<CallbackResultType> {
    const message = new Message(attrs);
    const silent = false;

    return Promise.all([
      this.uploadAttachments(message),
      this.uploadThumbnails(message),
      this.uploadLinkPreviews(message),
      this.uploadSticker(message),
    ]).then(
      async (): Promise<CallbackResultType> =>
        new Promise((resolve, reject) => {
          this.sendMessageProto(
            message.timestamp,
            message.recipients || [],
            message.toProto(),
            (res: CallbackResultType) => {
              res.dataMessage = message.toArrayBuffer();
              if (res.errors && res.errors.length > 0) {
                reject(res);
              } else {
                resolve(res);
              }
            },
            silent,
            options
          );
        })
    );
  }
  sendMessageProto(
    timestamp: number,
    recipients: Array<string>,
    messageProto: DataMessageClass,
    callback: (result: CallbackResultType) => void,
    silent?: boolean,
    options?: SendOptionsType
  ) {
    const rejections = window.textsecure.storage.get(
      'signedKeyRotationRejected',
      0
    );
    if (rejections > 5) {
      throw new SignedPreKeyRotationError();
    }

    const outgoing = new OutgoingMessage(
      this.server,
      timestamp,
      recipients,
      messageProto,
      silent,
      callback,
      options
    );

    recipients.forEach(identifier => {
      // tslint:disable-next-line no-floating-promises
      this.queueJobForIdentifier(identifier, async () =>
        outgoing.sendToIdentifier(identifier)
      );
    });
  }

  async sendMessageProtoAndWait(
    timestamp: number,
    identifiers: Array<string>,
    messageProto: DataMessageClass,
    silent?: boolean,
    options?: SendOptionsType
  ) {
    return new Promise((resolve, reject) => {
      const callback = (result: CallbackResultType) => {
        if (result && result.errors && result.errors.length > 0) {
          reject(result);
          return;
        }

        resolve(result);
        return;
      };

      this.sendMessageProto(
        timestamp,
        identifiers,
        messageProto,
        callback,
        silent,
        options
      );
    });
  }

  async sendIndividualProto(
    identifier: string,
    proto: DataMessageClass | ContentClass,
    timestamp: number,
    silent?: boolean,
    options?: SendOptionsType
  ) {
    return new Promise((resolve, reject) => {
      const callback = (res: CallbackResultType) => {
        if (res && res.errors && res.errors.length > 0) {
          reject(res);
        } else {
          resolve(res);
        }
      };
      this.sendMessageProto(
        timestamp,
        [identifier],
        proto,
        callback,
        silent,
        options
      );
    });
  }

  createSyncMessage() {
    const syncMessage = new window.textsecure.protobuf.SyncMessage();

    // Generate a random int from 1 and 512
    const buffer = window.libsignal.crypto.getRandomBytes(1);
    const paddingLength = (new Uint8Array(buffer)[0] & 0x1ff) + 1;

    // Generate a random padding buffer of the chosen size
    syncMessage.padding = window.libsignal.crypto.getRandomBytes(paddingLength);

    return syncMessage;
  }

  async sendSyncMessage(
    encodedDataMessage: ArrayBuffer,
    timestamp: number,
    destination: string,
    destinationUuid: string | null,
    expirationStartTimestamp: number | null,
    sentTo: Array<string> = [],
    unidentifiedDeliveries: Array<string> = [],
    isUpdate: boolean = false,
    options?: SendOptionsType
  ) {
    const myNumber = window.textsecure.storage.user.getNumber();
    const myUuid = window.textsecure.storage.user.getUuid();
    const myDevice = window.textsecure.storage.user.getDeviceId();

    if (myDevice === 1 || myDevice === '1') {
      return Promise.resolve();
    }

    const dataMessage = window.textsecure.protobuf.DataMessage.decode(
      encodedDataMessage
    );
    const sentMessage = new window.textsecure.protobuf.SyncMessage.Sent();
    sentMessage.timestamp = timestamp;
    sentMessage.message = dataMessage;
    if (destination) {
      sentMessage.destination = destination;
    }
    if (destinationUuid) {
      sentMessage.destinationUuid = destinationUuid;
    }
    if (expirationStartTimestamp) {
      sentMessage.expirationStartTimestamp = expirationStartTimestamp;
    }

    const unidentifiedLookup = unidentifiedDeliveries.reduce(
      (accumulator, item) => {
        // eslint-disable-next-line no-param-reassign
        accumulator[item] = true;
        return accumulator;
      },
      Object.create(null)
    );

    if (isUpdate) {
      sentMessage.isRecipientUpdate = true;
    }

    // Though this field has 'unidenified' in the name, it should have entries for each
    //   number we sent to.
    if (sentTo && sentTo.length) {
      sentMessage.unidentifiedStatus = sentTo.map(identifier => {
        const status = new window.textsecure.protobuf.SyncMessage.Sent.UnidentifiedDeliveryStatus();
        const conv = window.ConversationController.get(identifier);
        if (conv && conv.get('e164')) {
          status.destination = conv.get('e164');
        }
        if (conv && conv.get('uuid')) {
          status.destinationUuid = conv.get('uuid');
        }
        status.unidentified = Boolean(unidentifiedLookup[identifier]);
        return status;
      });
    }

    const syncMessage = this.createSyncMessage();
    syncMessage.sent = sentMessage;
    const contentMessage = new window.textsecure.protobuf.Content();
    contentMessage.syncMessage = syncMessage;

    const silent = true;
    return this.sendIndividualProto(
      myUuid || myNumber,
      contentMessage,
      timestamp,
      silent,
      options
    );
  }

  async getProfile(
    number: string,
    options: {
      accessKey?: string;
      profileKeyVersion?: string;
      profileKeyCredentialRequest?: string;
    } = {}
  ) {
    const { accessKey } = options;

    if (accessKey) {
      const unauthOptions = {
        ...options,
        accessKey,
      };
      return this.server.getProfileUnauth(number, unauthOptions);
    }

    return this.server.getProfile(number, options);
  }

  async getUuidsForE164s(
    numbers: Array<string>
  ): Promise<Dictionary<string | null>> {
    return this.server.getUuidsForE164s(numbers);
  }

  async getAvatar(path: string) {
    return this.server.getAvatar(path);
  }

  async getSticker(packId: string, stickerId: string) {
    return this.server.getSticker(packId, stickerId);
  }
  async getStickerPackManifest(packId: string) {
    return this.server.getStickerPackManifest(packId);
  }

  async sendRequestBlockSyncMessage(options?: SendOptionsType) {
    const myNumber = window.textsecure.storage.user.getNumber();
    const myUuid = window.textsecure.storage.user.getUuid();
    const myDevice = window.textsecure.storage.user.getDeviceId();
    if (myDevice !== 1 && myDevice !== '1') {
      const request = new window.textsecure.protobuf.SyncMessage.Request();
      request.type =
        window.textsecure.protobuf.SyncMessage.Request.Type.BLOCKED;
      const syncMessage = this.createSyncMessage();
      syncMessage.request = request;
      const contentMessage = new window.textsecure.protobuf.Content();
      contentMessage.syncMessage = syncMessage;

      const silent = true;
      return this.sendIndividualProto(
        myUuid || myNumber,
        contentMessage,
        Date.now(),
        silent,
        options
      );
    }

    return Promise.resolve();
  }

  async sendRequestConfigurationSyncMessage(options?: SendOptionsType) {
    const myNumber = window.textsecure.storage.user.getNumber();
    const myUuid = window.textsecure.storage.user.getUuid();
    const myDevice = window.textsecure.storage.user.getDeviceId();
    if (myDevice !== 1 && myDevice !== '1') {
      const request = new window.textsecure.protobuf.SyncMessage.Request();
      request.type =
        window.textsecure.protobuf.SyncMessage.Request.Type.CONFIGURATION;
      const syncMessage = this.createSyncMessage();
      syncMessage.request = request;
      const contentMessage = new window.textsecure.protobuf.Content();
      contentMessage.syncMessage = syncMessage;

      const silent = true;
      return this.sendIndividualProto(
        myUuid || myNumber,
        contentMessage,
        Date.now(),
        silent,
        options
      );
    }

    return Promise.resolve();
  }

  async sendRequestGroupSyncMessage(options?: SendOptionsType) {
    const myNumber = window.textsecure.storage.user.getNumber();
    const myUuid = window.textsecure.storage.user.getUuid();
    const myDevice = window.textsecure.storage.user.getDeviceId();
    if (myDevice !== 1 && myDevice !== '1') {
      const request = new window.textsecure.protobuf.SyncMessage.Request();
      request.type = window.textsecure.protobuf.SyncMessage.Request.Type.GROUPS;
      const syncMessage = this.createSyncMessage();
      syncMessage.request = request;
      const contentMessage = new window.textsecure.protobuf.Content();
      contentMessage.syncMessage = syncMessage;

      const silent = true;
      return this.sendIndividualProto(
        myUuid || myNumber,
        contentMessage,
        Date.now(),
        silent,
        options
      );
    }

    return Promise.resolve();
  }

  async sendRequestContactSyncMessage(options?: SendOptionsType) {
    const myNumber = window.textsecure.storage.user.getNumber();
    const myUuid = window.textsecure.storage.user.getUuid();

    const myDevice = window.textsecure.storage.user.getDeviceId();
    if (myDevice !== 1 && myDevice !== '1') {
      const request = new window.textsecure.protobuf.SyncMessage.Request();
      request.type =
        window.textsecure.protobuf.SyncMessage.Request.Type.CONTACTS;
      const syncMessage = this.createSyncMessage();
      syncMessage.request = request;
      const contentMessage = new window.textsecure.protobuf.Content();
      contentMessage.syncMessage = syncMessage;

      const silent = true;
      return this.sendIndividualProto(
        myUuid || myNumber,
        contentMessage,
        Date.now(),
        silent,
        options
      );
    }

    return Promise.resolve();
  }

  async sendFetchManifestSyncMessage(options?: SendOptionsType) {
    const myUuid = window.textsecure.storage.user.getUuid();
    const myNumber = window.textsecure.storage.user.getNumber();
    const myDevice = window.textsecure.storage.user.getDeviceId();

    if (myDevice === 1 || myDevice === '1') {
      return;
    }

    const fetchLatest = new window.textsecure.protobuf.SyncMessage.FetchLatest();
    fetchLatest.type =
      window.textsecure.protobuf.SyncMessage.FetchLatest.Type.STORAGE_MANIFEST;

    const syncMessage = this.createSyncMessage();
    syncMessage.fetchLatest = fetchLatest;
    const contentMessage = new window.textsecure.protobuf.Content();
    contentMessage.syncMessage = syncMessage;

    const silent = true;
    await this.sendIndividualProto(
      myUuid || myNumber,
      contentMessage,
      Date.now(),
      silent,
      options
    );
  }

  async sendRequestKeySyncMessage(options?: SendOptionsType) {
    const myUuid = window.textsecure.storage.user.getUuid();
    const myNumber = window.textsecure.storage.user.getNumber();
    const myDevice = window.textsecure.storage.user.getDeviceId();

    if (myDevice === 1 || myDevice === '1') {
      return;
    }

    const request = new window.textsecure.protobuf.SyncMessage.Request();
    request.type = window.textsecure.protobuf.SyncMessage.Request.Type.KEYS;

    const syncMessage = this.createSyncMessage();
    syncMessage.request = request;
    const contentMessage = new window.textsecure.protobuf.Content();
    contentMessage.syncMessage = syncMessage;

    const silent = true;
    await this.sendIndividualProto(
      myUuid || myNumber,
      contentMessage,
      Date.now(),
      silent,
      options
    );
  }

  async sendTypingMessage(
    options: {
      recipientId: string;
      groupId: string;
      groupMembers: Array<string>;
      isTyping: boolean;
      timestamp: number;
    },
    sendOptions: SendOptionsType = {}
  ) {
    const ACTION_ENUM = window.textsecure.protobuf.TypingMessage.Action;
    const { recipientId, groupId, groupMembers, isTyping, timestamp } = options;

    // We don't want to send typing messages to our other devices, but we will
    //   in the group case.
    const myNumber = window.textsecure.storage.user.getNumber();
    const myUuid = window.textsecure.storage.user.getUuid();
    if (recipientId && (myNumber === recipientId || myUuid === recipientId)) {
      return null;
    }

    if (!recipientId && !groupId) {
      throw new Error('Need to provide either recipientId or groupId!');
    }

    const recipients = groupId
      ? (without(groupMembers, myNumber, myUuid) as Array<string>)
      : [recipientId];
    const groupIdBuffer = groupId
      ? fromEncodedBinaryToArrayBuffer(groupId)
      : null;

    const action = isTyping ? ACTION_ENUM.STARTED : ACTION_ENUM.STOPPED;
    const finalTimestamp = timestamp || Date.now();

    const typingMessage = new window.textsecure.protobuf.TypingMessage();
    typingMessage.groupId = groupIdBuffer;
    typingMessage.action = action;
    typingMessage.timestamp = finalTimestamp;

    const contentMessage = new window.textsecure.protobuf.Content();
    contentMessage.typingMessage = typingMessage;

    const silent = true;
    const online = true;

    return this.sendMessageProtoAndWait(
      finalTimestamp,
      recipients,
      contentMessage,
      silent,
      {
        ...sendOptions,
        online,
      }
    );
  }

  async sendProfileKeyUpdate(
    profileKey: ArrayBuffer,
    recipients: Array<string>,
    sendOptions: SendOptionsType,
    groupId?: string
  ) {
    return this.sendMessage(
      {
        recipients,
        timestamp: Date.now(),
        profileKey,
        flags: window.textsecure.protobuf.DataMessage.Flags.PROFILE_KEY_UPDATE,
        ...(groupId
          ? {
              group: {
                id: groupId,
                type: window.textsecure.protobuf.GroupContext.Type.DELIVER,
              },
            }
          : {}),
      },
      sendOptions
    );
  }

  async sendCallingMessage(
    recipientId: string,
    callingMessage: CallingMessageClass,
    sendOptions?: SendOptionsType
  ) {
    const recipients = [recipientId];
    const finalTimestamp = Date.now();

    const contentMessage = new window.textsecure.protobuf.Content();
    contentMessage.callingMessage = callingMessage;

    const silent = true;

    await this.sendMessageProtoAndWait(
      finalTimestamp,
      recipients,
      contentMessage,
      silent,
      sendOptions
    );
  }

  async sendDeliveryReceipt(
    recipientE164: string,
    recipientUuid: string,
    timestamps: Array<number>,
    options?: SendOptionsType
  ) {
    const myNumber = window.textsecure.storage.user.getNumber();
    const myUuid = window.textsecure.storage.user.getUuid();
    const myDevice = window.textsecure.storage.user.getDeviceId();
    if (
      (myNumber === recipientE164 || myUuid === recipientUuid) &&
      (myDevice === 1 || myDevice === '1')
    ) {
      return Promise.resolve();
    }

    const receiptMessage = new window.textsecure.protobuf.ReceiptMessage();
    receiptMessage.type =
      window.textsecure.protobuf.ReceiptMessage.Type.DELIVERY;
    receiptMessage.timestamp = timestamps;

    const contentMessage = new window.textsecure.protobuf.Content();
    contentMessage.receiptMessage = receiptMessage;

    const silent = true;
    return this.sendIndividualProto(
      recipientUuid || recipientE164,
      contentMessage,
      Date.now(),
      silent,
      options
    );
  }

  async sendReadReceipts(
    senderE164: string,
    senderUuid: string,
    timestamps: Array<number>,
    options?: SendOptionsType
  ) {
    const receiptMessage = new window.textsecure.protobuf.ReceiptMessage();
    receiptMessage.type = window.textsecure.protobuf.ReceiptMessage.Type.READ;
    receiptMessage.timestamp = timestamps;

    const contentMessage = new window.textsecure.protobuf.Content();
    contentMessage.receiptMessage = receiptMessage;

    const silent = true;
    return this.sendIndividualProto(
      senderUuid || senderE164,
      contentMessage,
      Date.now(),
      silent,
      options
    );
  }
  async syncReadMessages(
    reads: Array<{
      senderUuid?: string;
      senderE164?: string;
      timestamp: number;
    }>,
    options?: SendOptionsType
  ) {
    const myNumber = window.textsecure.storage.user.getNumber();
    const myUuid = window.textsecure.storage.user.getUuid();
    const myDevice = window.textsecure.storage.user.getDeviceId();
    if (myDevice !== 1 && myDevice !== '1') {
      const syncMessage = this.createSyncMessage();
      syncMessage.read = [];
      for (let i = 0; i < reads.length; i += 1) {
        const read = new window.textsecure.protobuf.SyncMessage.Read();
        read.timestamp = reads[i].timestamp;
        read.sender = reads[i].senderE164;
        read.senderUuid = reads[i].senderUuid;

        syncMessage.read.push(read);
      }
      const contentMessage = new window.textsecure.protobuf.Content();
      contentMessage.syncMessage = syncMessage;

      const silent = true;
      return this.sendIndividualProto(
        myUuid || myNumber,
        contentMessage,
        Date.now(),
        silent,
        options
      );
    }

    return Promise.resolve();
  }

  async syncViewOnceOpen(
    sender: string,
    senderUuid: string,
    timestamp: number,
    options?: SendOptionsType
  ) {
    const myNumber = window.textsecure.storage.user.getNumber();
    const myUuid = window.textsecure.storage.user.getUuid();
    const myDevice = window.textsecure.storage.user.getDeviceId();
    if (myDevice === 1 || myDevice === '1') {
      return null;
    }

    const syncMessage = this.createSyncMessage();

    const viewOnceOpen = new window.textsecure.protobuf.SyncMessage.ViewOnceOpen();
    viewOnceOpen.sender = sender;
    viewOnceOpen.senderUuid = senderUuid;
    viewOnceOpen.timestamp = timestamp;
    syncMessage.viewOnceOpen = viewOnceOpen;

    const contentMessage = new window.textsecure.protobuf.Content();
    contentMessage.syncMessage = syncMessage;

    const silent = true;
    return this.sendIndividualProto(
      myUuid || myNumber,
      contentMessage,
      Date.now(),
      silent,
      options
    );
  }

  async syncMessageRequestResponse(
    responseArgs: {
      threadE164?: string;
      threadUuid?: string;
      groupId?: string;
      type: number;
    },
    sendOptions?: SendOptionsType
  ) {
    const myNumber = window.textsecure.storage.user.getNumber();
    const myUuid = window.textsecure.storage.user.getUuid();
    const myDevice = window.textsecure.storage.user.getDeviceId();
    if (myDevice === 1 || myDevice === '1') {
      return null;
    }

    const syncMessage = this.createSyncMessage();

    const response = new window.textsecure.protobuf.SyncMessage.MessageRequestResponse();
    response.threadE164 = responseArgs.threadE164;
    response.threadUuid = responseArgs.threadUuid;
    response.groupId = responseArgs.groupId
      ? window.Signal.Crypto.fromEncodedBinaryToArrayBuffer(
          responseArgs.groupId
        )
      : null;
    response.type = responseArgs.type;
    syncMessage.messageRequestResponse = response;

    const contentMessage = new window.textsecure.protobuf.Content();
    contentMessage.syncMessage = syncMessage;

    const silent = true;
    return this.sendIndividualProto(
      myUuid || myNumber,
      contentMessage,
      Date.now(),
      silent,
      sendOptions
    );
  }

  async sendStickerPackSync(
    operations: Array<{
      packId: string;
      packKey: string;
      installed: boolean;
    }>,
    options?: SendOptionsType
  ) {
    const myDevice = window.textsecure.storage.user.getDeviceId();
    if (myDevice === 1 || myDevice === '1') {
      return null;
    }

    const myNumber = window.textsecure.storage.user.getNumber();
    const myUuid = window.textsecure.storage.user.getUuid();
    const ENUM =
      window.textsecure.protobuf.SyncMessage.StickerPackOperation.Type;

    const packOperations = operations.map(item => {
      const { packId, packKey, installed } = item;

      const operation = new window.textsecure.protobuf.SyncMessage.StickerPackOperation();
      operation.packId = hexToArrayBuffer(packId);
      operation.packKey = base64ToArrayBuffer(packKey);
      operation.type = installed ? ENUM.INSTALL : ENUM.REMOVE;

      return operation;
    });

    const syncMessage = this.createSyncMessage();
    syncMessage.stickerPackOperation = packOperations;

    const contentMessage = new window.textsecure.protobuf.Content();
    contentMessage.syncMessage = syncMessage;

    const silent = true;
    return this.sendIndividualProto(
      myUuid || myNumber,
      contentMessage,
      Date.now(),
      silent,
      options
    );
  }

  async syncVerification(
    destinationE164: string,
    destinationUuid: string,
    state: number,
    identityKey: ArrayBuffer,
    options?: SendOptionsType
  ) {
    const myNumber = window.textsecure.storage.user.getNumber();
    const myUuid = window.textsecure.storage.user.getUuid();
    const myDevice = window.textsecure.storage.user.getDeviceId();
    const now = Date.now();

    if (myDevice === 1 || myDevice === '1') {
      return Promise.resolve();
    }

    // First send a null message to mask the sync message.
    const nullMessage = new window.textsecure.protobuf.NullMessage();

    // Generate a random int from 1 and 512
    const buffer = window.libsignal.crypto.getRandomBytes(1);
    const paddingLength = (new Uint8Array(buffer)[0] & 0x1ff) + 1;

    // Generate a random padding buffer of the chosen size
    nullMessage.padding = window.libsignal.crypto.getRandomBytes(paddingLength);

    const contentMessage = new window.textsecure.protobuf.Content();
    contentMessage.nullMessage = nullMessage;

    // We want the NullMessage to look like a normal outgoing message; not silent
    const silent = false;
    const promise = this.sendIndividualProto(
      destinationUuid || destinationE164,
      contentMessage,
      now,
      silent,
      options
    );

    return promise.then(async () => {
      const verified = new window.textsecure.protobuf.Verified();
      verified.state = state;
      if (destinationE164) {
        verified.destination = destinationE164;
      }
      if (destinationUuid) {
        verified.destinationUuid = destinationUuid;
      }
      verified.identityKey = identityKey;
      verified.nullMessage = nullMessage.padding;

      const syncMessage = this.createSyncMessage();
      syncMessage.verified = verified;

      const secondMessage = new window.textsecure.protobuf.Content();
      secondMessage.syncMessage = syncMessage;

      const innerSilent = true;
      return this.sendIndividualProto(
        myUuid || myNumber,
        secondMessage,
        now,
        innerSilent,
        options
      );
    });
  }

  async sendGroupProto(
    providedIdentifiers: Array<string>,
    proto: DataMessageClass,
    timestamp = Date.now(),
    options = {}
  ) {
    const myE164 = window.textsecure.storage.user.getNumber();
    const myUuid = window.textsecure.storage.user.getUuid();
    const identifiers = providedIdentifiers.filter(
      id => id !== myE164 && id !== myUuid
    );

    if (identifiers.length === 0) {
      return Promise.resolve({
        successfulIdentifiers: [],
        failoverIdentifiers: [],
        errors: [],
        unidentifiedDeliveries: [],
        dataMessage: proto.toArrayBuffer(),
      });
    }

    return new Promise((resolve, reject) => {
      const silent = true;
      const callback = (res: CallbackResultType) => {
        res.dataMessage = proto.toArrayBuffer();
        if (res.errors && res.errors.length > 0) {
          reject(res);
        } else {
          resolve(res);
        }
      };

      this.sendMessageProto(
        timestamp,
        providedIdentifiers,
        proto,
        callback,
        silent,
        options
      );
    });
  }

  async getMessageProto(
    destination: string,
    body: string,
    attachments: Array<AttachmentType> | null,
    quote: any,
    preview: Array<PreviewType> | null,
    sticker: any,
    reaction: any,
    timestamp: number,
    expireTimer: number | undefined,
    profileKey?: ArrayBuffer,
    flags?: number
  ) {
    const attributes = {
      recipients: [destination],
      destination,
      body,
      timestamp,
      attachments,
      quote,
      preview,
      sticker,
      reaction,
      expireTimer,
      profileKey,
      flags,
    };

    return this.getMessageProtoObj(attributes);
  }

  async getMessageProtoObj(attributes: MessageOptionsType) {
    const message = new Message(attributes);
    await Promise.all([
      this.uploadAttachments(message),
      this.uploadThumbnails(message),
      this.uploadLinkPreviews(message),
      this.uploadSticker(message),
    ]);

    return message.toArrayBuffer();
  }

  async sendMessageToIdentifier(
    identifier: string,
    messageText: string,
    attachments: Array<AttachmentType> | null,
    quote: any,
    preview: Array<PreviewType> | null,
    sticker: any,
    reaction: any,
    timestamp: number,
    expireTimer: number | undefined,
    profileKey?: ArrayBuffer,
    options?: SendOptionsType
  ) {
    return this.sendMessage(
      {
        recipients: [identifier],
        body: messageText,
        timestamp,
        attachments,
        quote,
        preview,
        sticker,
        reaction,
        expireTimer,
        profileKey,
      },
      options
    );
  }

  async resetSession(
    uuid: string,
    e164: string,
    timestamp: number,
    options?: SendOptionsType
  ) {
    window.log.info('resetting secure session');
    const silent = false;
    const proto = new window.textsecure.protobuf.DataMessage();
    proto.body = 'TERMINATE';
    proto.flags = window.textsecure.protobuf.DataMessage.Flags.END_SESSION;
    proto.timestamp = timestamp;

    const identifier = uuid || e164;

    const logError = (prefix: string) => (error: Error) => {
      window.log.error(prefix, error && error.stack ? error.stack : error);
      throw error;
    };
    const deleteAllSessions = async (targetIdentifier: string) =>
      window.textsecure.storage.protocol
        .getDeviceIds(targetIdentifier)
        .then(async deviceIds =>
          Promise.all(
            deviceIds.map(async deviceId => {
              const address = new window.libsignal.SignalProtocolAddress(
                targetIdentifier,
                deviceId
              );
              window.log.info('deleting sessions for', address.toString());
              const sessionCipher = new window.libsignal.SessionCipher(
                window.textsecure.storage.protocol,
                address
              );
              return sessionCipher.deleteAllSessionsForDevice();
            })
          )
        );

    const sendToContactPromise = deleteAllSessions(identifier)
      .catch(logError('resetSession/deleteAllSessions1 error:'))
      .then(async () => {
        window.log.info(
          'finished closing local sessions, now sending to contact'
        );
        return this.sendIndividualProto(
          identifier,
          proto,
          timestamp,
          silent,
          options
        ).catch(logError('resetSession/sendToContact error:'));
      })
      .then(async () =>
        deleteAllSessions(identifier).catch(
          logError('resetSession/deleteAllSessions2 error:')
        )
      );

    const myNumber = window.textsecure.storage.user.getNumber();
    const myUuid = window.textsecure.storage.user.getUuid();
    // We already sent the reset session to our other devices in the code above!
    if ((e164 && e164 === myNumber) || (uuid && uuid === myUuid)) {
      return sendToContactPromise;
    }

    const buffer = proto.toArrayBuffer();
    const sendSyncPromise = this.sendSyncMessage(
      buffer,
      timestamp,
      e164,
      uuid,
      null,
      [],
      [],
      false,
      options
    ).catch(logError('resetSession/sendSync error:'));

    return Promise.all([sendToContactPromise, sendSyncPromise]);
  }

  async sendMessageToGroup(
    {
      attachments,
      expireTimer,
      groupV2,
      groupV1,
      messageText,
      preview,
      profileKey,
      quote,
      reaction,
      sticker,
      timestamp,
    }: {
      attachments?: Array<AttachmentType>;
      expireTimer?: number;
      groupV2?: GroupV2InfoType;
      groupV1?: GroupV1InfoType;
      messageText?: string;
      preview?: any;
      profileKey?: ArrayBuffer;
      quote?: any;
      reaction?: any;
      sticker?: any;
      timestamp: number;
    },
    options?: SendOptionsType
  ): Promise<CallbackResultType> {
    if (!groupV1 && !groupV2) {
      throw new Error(
        'sendMessageToGroup: Neither group1 nor groupv2 information provided!'
      );
    }

    const myE164 = window.textsecure.storage.user.getNumber();
    const myUuid = window.textsecure.storage.user.getNumber();
    // prettier-ignore
    const recipients = groupV2
      ? groupV2.members
      : groupV1
        ? groupV1.members
        : [];

    const attrs = {
      recipients: recipients.filter(r => r !== myE164 && r !== myUuid),
      body: messageText,
      timestamp,
      attachments,
      quote,
      preview,
      sticker,
      reaction,
      expireTimer,
      profileKey,
      groupV2,
      group: groupV1
        ? {
            id: groupV1.id,
            type: window.textsecure.protobuf.GroupContext.Type.DELIVER,
          }
        : undefined,
    };

    if (recipients.length === 0) {
      return Promise.resolve({
        successfulIdentifiers: [],
        failoverIdentifiers: [],
        errors: [],
        unidentifiedDeliveries: [],
        dataMessage: await this.getMessageProtoObj(attrs),
        discoveredIdentifierPairs: [],
      });
    }

    return this.sendMessage(attrs, options);
  }

  async getGroup(options: GroupCredentialsType): Promise<GroupClass> {
    return this.server.getGroup(options);
  }
  async getGroupLog(
    startVersion: number,
    options: GroupCredentialsType
  ): Promise<GroupLogResponseType> {
    return this.server.getGroupLog(startVersion, options);
  }
  async getGroupAvatar(key: string): Promise<ArrayBuffer> {
    return this.server.getGroupAvatar(key);
  }
  async modifyGroup(
    changes: GroupChangeClass.Actions,
    options: GroupCredentialsType
  ): Promise<GroupChangeClass> {
    return this.server.modifyGroup(changes, options);
  }

  async sendExpirationTimerUpdateToGroup(
    groupId: string,
    groupIdentifiers: Array<string>,
    expireTimer: number | undefined,
    timestamp: number,
    profileKey?: ArrayBuffer,
    options?: SendOptionsType
  ): Promise<CallbackResultType> {
    const myNumber = window.textsecure.storage.user.getNumber();
    const myUuid = window.textsecure.storage.user.getUuid();
    const recipients = groupIdentifiers.filter(
      identifier => identifier !== myNumber && identifier !== myUuid
    );
    const attrs = {
      recipients,
      timestamp,
      expireTimer,
      profileKey,
      flags:
        window.textsecure.protobuf.DataMessage.Flags.EXPIRATION_TIMER_UPDATE,
      group: {
        id: groupId,
        type: window.textsecure.protobuf.GroupContext.Type.DELIVER,
      },
    };

    if (recipients.length === 0) {
      return Promise.resolve({
        successfulIdentifiers: [],
        failoverIdentifiers: [],
        errors: [],
        unidentifiedDeliveries: [],
        dataMessage: await this.getMessageProtoObj(attrs),
        discoveredIdentifierPairs: [],
      });
    }

    return this.sendMessage(attrs, options);
  }

  async sendExpirationTimerUpdateToIdentifier(
    identifier: string,
    expireTimer: number | undefined,
    timestamp: number,
    profileKey?: ArrayBuffer,
    options?: SendOptionsType
  ) {
    return this.sendMessage(
      {
        recipients: [identifier],
        timestamp,
        expireTimer,
        profileKey,
        flags:
          window.textsecure.protobuf.DataMessage.Flags.EXPIRATION_TIMER_UPDATE,
      },
      options
    );
  }
  async makeProxiedRequest(url: string, options?: ProxiedRequestOptionsType) {
    return this.server.makeProxiedRequest(url, options);
  }

  async getStorageCredentials(): Promise<StorageServiceCredentials> {
    return this.server.getStorageCredentials();
  }

  async getStorageManifest(
    options: StorageServiceCallOptionsType
  ): Promise<ArrayBuffer> {
    return this.server.getStorageManifest(options);
  }

  async getStorageRecords(
    data: ArrayBuffer,
    options: StorageServiceCallOptionsType
  ): Promise<ArrayBuffer> {
    return this.server.getStorageRecords(data, options);
  }

  async modifyStorageRecords(
    data: ArrayBuffer,
    options: StorageServiceCallOptionsType
  ): Promise<ArrayBuffer> {
    return this.server.modifyStorageRecords(data, options);
  }
}
