import { Message } from "@ag-ui/client";
import { WhatsAppMessage, WhatsAppSendMessageRequest } from "../types";

/**
 * Convert WhatsApp message to AG-UI message format
 */
export function convertWhatsAppMessageToAGUI(whatsappMessage: WhatsAppMessage): Message {
  let content = "";
  
  switch (whatsappMessage.type) {
    case "text":
      content = whatsappMessage.text?.body || "";
      break;
    case "image":
      content = `[Image]${whatsappMessage.image?.caption ? `: ${whatsappMessage.image.caption}` : ""}`;
      break;
    case "audio":
      content = "[Audio message]";
      break;
    case "document":
      content = `[Document: ${whatsappMessage.document?.filename || "Unknown file"}]`;
      break;
    case "video":
      content = `[Video]${whatsappMessage.video?.caption ? `: ${whatsappMessage.video.caption}` : ""}`;
      break;
    case "location":
      const location = whatsappMessage.location;
      content = `[Location: ${location?.name || "Unknown location"} at ${location?.latitude}, ${location?.longitude}]`;
      break;
    case "contact":
      const contacts = whatsappMessage.contacts;
      if (contacts && contacts.length > 0) {
        const contact = contacts[0];
        content = `[Contact: ${contact.name.formatted_name}]`;
      }
      break;
    default:
      content = `[${whatsappMessage.type} message]`;
  }

  return {
    id: whatsappMessage.id,
    role: "user",
    content,
  };
}

/**
 * Convert AG-UI message to WhatsApp message format
 */
export function convertAGUIMessageToWhatsApp(message: Message): WhatsAppSendMessageRequest {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: "", // This will be set by the caller
    type: "text",
    text: {
      body: message.content || "",
    },
  };
} 