export const CHAT_MESSAGE_CREATED = 'chat.message.created';
export const CHAT_TYPING_UPDATE = 'chat.typing.update';
export const CHAT_CONVERSATION_READ = 'chat.conversation.read';
export const OPERATOR_MESSAGE_SENT = 'operator.message.sent';
export const OPERATOR_TYPING_UPDATE = 'operator.typing.update';

export interface ChatMessageCreatedEvent {
  conversationId: string;
  senderProfileId: string;
  recipientProfileIds: string[];
  message: any; // MessageWithSender payload with sentAt as ISO string
  source: 'user' | 'operator';
  sentByOperatorId?: string;
}

export interface ChatTypingEvent {
  conversationId: string;
  profileId: string;
  isTyping: boolean;
  source: 'user' | 'operator';
  targetProfileIds: string[];
}

export interface ChatConversationReadEvent {
  conversationId: string;
  profileId: string;
  lastReadAt: string;
}
