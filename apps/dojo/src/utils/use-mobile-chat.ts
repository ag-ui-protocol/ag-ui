import React, { useEffect, useRef, useState } from "react";

import {
  MOBILE_CHAT_MIN_HEIGHT,
  resolveMobileChatDragHeight,
} from "./mobile-chat-drag";

export function useMobileChat(defaultChatHeight = 50) {
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [chatHeight, setChatHeight] = useState(defaultChatHeight); // Initial height as percentage
  const [isDragging, setIsDragging] = useState(false);
  const [dragStartY, setDragStartY] = useState(0);
  const [dragStartHeight, setDragStartHeight] = useState(defaultChatHeight);
  // Raw (unclamped) drag position in percent. The rendered height is
  // clamped to [50, 100], so the close decision must not read the clamped
  // value: it could never fall below 50 (ag-ui-protocol/ag-ui#2471).
  const dragHeightRef = useRef(defaultChatHeight);

  // Drag functionality for chat resize
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;

      const deltaY = dragStartY - e.clientY;
      const windowHeight = window.innerHeight;
      const newHeightPx = (dragStartHeight / 100) * windowHeight + deltaY;
      const newHeightPercent = (newHeightPx / windowHeight) * 100;

      const { displayHeight } = resolveMobileChatDragHeight(newHeightPercent);
      dragHeightRef.current = newHeightPercent;
      setChatHeight(displayHeight);
    };

    const handleMouseUp = () => {
      if (isDragging) {
        // Close if dragged below 50% (judged on the raw drag position)
        if (dragHeightRef.current < MOBILE_CHAT_MIN_HEIGHT) {
          setIsChatOpen(false);
          setChatHeight(defaultChatHeight); // Reset to default
        }
        setIsDragging(false);
      }
    };

    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.userSelect = 'none'; // Prevent text selection while dragging
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.userSelect = '';
    };
  }, [isDragging, dragStartY, dragStartHeight, chatHeight, defaultChatHeight]);

  const handleDragStart = (e: React.MouseEvent) => {
    setIsDragging(true);
    setDragStartY(e.clientY);
    setDragStartHeight(chatHeight);
    dragHeightRef.current = chatHeight;
  };

  return {
    isChatOpen,
    setChatHeight,
    setIsChatOpen,
    isDragging,
    chatHeight,
    handleDragStart
  }
}
