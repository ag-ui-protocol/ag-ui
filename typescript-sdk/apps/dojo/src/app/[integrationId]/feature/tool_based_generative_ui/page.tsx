"use client";
import { CopilotKit, useCopilotAction } from "@copilotkit/react-core";
import { CopilotKitCSSProperties, CopilotSidebar, CopilotChat } from "@copilotkit/react-ui";
import { Dispatch, SetStateAction, useState, useEffect } from "react";
import "@copilotkit/react-ui/styles.css";
import "./style.css";
import React, { useMemo } from "react";
import { useMobileView } from "@/utils/use-mobile-view";
import { useMobileChat } from "@/utils/use-mobile-chat";

interface ToolBasedGenerativeUIProps {
  params: Promise<{
    integrationId: string;
  }>;
}

interface GenerateHaiku{
  japanese : string[] | [],
  english : string[] | [],
  image_names : string[] | [],
  selectedImage : string | null,
}

interface HaikuCardProps{
  generatedHaiku : GenerateHaiku | Partial<GenerateHaiku>
  setHaikus : Dispatch<SetStateAction<GenerateHaiku[]>>
  haikus : GenerateHaiku[]
}

export default function ToolBasedGenerativeUI({ params }: ToolBasedGenerativeUIProps) {
  const { integrationId } = React.use(params);
  const { isMobile } = useMobileView();
  const defaultChatHeight = 50
  const {
    isChatOpen,
    setChatHeight,
    setIsChatOpen,
    isDragging,
    chatHeight,
    handleDragStart
  } = useMobileChat(defaultChatHeight)

  const chatTitle = 'Haiku Generator'
  const chatDescription = 'Ask me to create haikus'
  const initialLabel = 'I\'m a haiku generator 👋. How can I help you?'

  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      agent="tool_based_generative_ui"
    >
      <div
        className={`${isMobile ? 'h-screen' : 'min-h-full'} w-full relative overflow-hidden`}
        style={
          {
            // "--copilot-kit-primary-color": "#222",
            // "--copilot-kit-separator-color": "#CCC",
          } as CopilotKitCSSProperties
        }
      >
        <Haiku />

        {/* Desktop Sidebar */}
        {!isMobile && (
          <CopilotSidebar
            defaultOpen={true}
            labels={{
              title: chatTitle,
              initial: initialLabel,
            }}
            clickOutsideToClose={false}
          />
        )}

        {/* Mobile Pull-Up Chat */}
        {isMobile && (
          <>
            {/* Chat Toggle Button */}
            <div className="fixed bottom-0 left-0 right-0 z-50">
              <div className="bg-gradient-to-t from-white via-white to-transparent h-6"></div>
              <div
                className="bg-white border-t border-gray-200 px-4 py-3 flex items-center justify-between cursor-pointer shadow-lg"
                onClick={() => {
                  if (!isChatOpen) {
                    setChatHeight(defaultChatHeight); // Reset to good default when opening
                  }
                  setIsChatOpen(!isChatOpen);
                }}
              >
                <div className="flex items-center gap-3">
                  <div>
                    <div className="font-medium text-gray-900">{chatTitle}</div>
                    <div className="text-sm text-gray-500">{chatDescription}</div>
                  </div>
                </div>
                <div className={`transform transition-transform duration-300 ${isChatOpen ? 'rotate-180' : ''}`}>
                  <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                  </svg>
                </div>
              </div>
            </div>

            {/* Pull-Up Chat Container */}
            <div
              className={`fixed inset-x-0 bottom-0 z-40 bg-white rounded-t-2xl shadow-[0px_0px_20px_0px_rgba(0,0,0,0.15)] transform transition-all duration-300 ease-in-out flex flex-col ${
                isChatOpen ? 'translate-y-0' : 'translate-y-full'
              } ${isDragging ? 'transition-none' : ''}`}
              style={{ 
                height: `${chatHeight}vh`,
                paddingBottom: 'env(safe-area-inset-bottom)' // Handle iPhone bottom padding
              }}
            >
              {/* Drag Handle Bar */}
              <div 
                className="flex justify-center pt-3 pb-2 flex-shrink-0 cursor-grab active:cursor-grabbing"
                onMouseDown={handleDragStart}
              >
                <div className="w-12 h-1 bg-gray-400 rounded-full hover:bg-gray-500 transition-colors"></div>
              </div>
              
              {/* Chat Header */}
              <div className="px-4 py-3 border-b border-gray-100 flex-shrink-0">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <h3 className="font-semibold text-gray-900">{chatTitle}</h3>
                  </div>
                  <button
                    onClick={() => setIsChatOpen(false)}
                    className="p-2 hover:bg-gray-100 rounded-full transition-colors"
                  >
                    <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>

              {/* Chat Content - Flexible container for messages and input */}
              <div className="flex-1 flex flex-col min-h-0 overflow-hidden pb-16">
                <CopilotChat
                  className="h-full flex flex-col"
                  labels={{
                    initial: initialLabel,
                  }}
                />
              </div>
            </div>

            {/* Backdrop */}
            {isChatOpen && (
              <div
                className="fixed inset-0 z-30"
                onClick={() => setIsChatOpen(false)}
              />
            )}
          </>
        )}
      </div>
    </CopilotKit>
  );
}

const VALID_IMAGE_NAMES = [
  "Osaka_Castle_Turret_Stone_Wall_Pine_Trees_Daytime.jpg",
  "Tokyo_Skyline_Night_Tokyo_Tower_Mount_Fuji_View.jpg",
  "Itsukushima_Shrine_Miyajima_Floating_Torii_Gate_Sunset_Long_Exposure.jpg",
  "Takachiho_Gorge_Waterfall_River_Lush_Greenery_Japan.jpg",
  "Bonsai_Tree_Potted_Japanese_Art_Green_Foliage.jpeg",
  "Shirakawa-go_Gassho-zukuri_Thatched_Roof_Village_Aerial_View.jpg",
  "Ginkaku-ji_Silver_Pavilion_Kyoto_Japanese_Garden_Pond_Reflection.jpg",
  "Senso-ji_Temple_Asakusa_Cherry_Blossoms_Kimono_Umbrella.jpg",
  "Cherry_Blossoms_Sakura_Night_View_City_Lights_Japan.jpg",
  "Mount_Fuji_Lake_Reflection_Cherry_Blossoms_Sakura_Spring.jpg"
];

function HaikuCard({generatedHaiku, setHaikus, haikus} : HaikuCardProps) {
  return (
    <div className="suggestion-card text-left rounded-md p-4 mt-4 mb-4 flex flex-col bg-gray-100">
      <div className="mb-4 pb-4">
        {generatedHaiku?.japanese?.map((line, index) => (
          <div className="flex items-center gap-3 mb-2" key={index}>
            <p className="text-lg font-bold">{line}</p>
            <p className="text-sm font-light">
              {generatedHaiku.english?.[index]}
            </p>
          </div>
        ))}
        {generatedHaiku?.japanese && generatedHaiku.japanese.length >= 2 && (
          <div className="mt-3 flex gap-2 justify-between w-full suggestion-image-container">
            {(() => {
              const firstLine = generatedHaiku?.japanese?.[0];
              if (!firstLine) return null;
              const haikuIndex = haikus.findIndex((h: any) => h.japanese[0] === firstLine);
              const haiku = haikus[haikuIndex];
              if (!haiku?.image_names) return null;

              return haiku.image_names.map((imageName, imgIndex) => (
                <img
                  key={haikus.length + "_" + imageName}
                  src={`/images/${imageName}`}
                  alt={imageName}
                  tabIndex={0}
                  className={`${haiku.selectedImage === imageName ? "suggestion-card-image-focus" : "suggestion-card-image"}`}
                  onClick={() => {
                    setHaikus(prevHaikus => {
                      const newHaikus = prevHaikus.map((h, idx) => {
                        if (idx === haikuIndex) {
                          return {
                            ...h,
                            selectedImage: imageName
                          };
                        }
                        return h;
                      });
                      return newHaikus;
                    });
                  }}
                />
              ));
            })()}
          </div>
        )}
      </div>
    </div>
  );
}

interface Haiku {
  japanese: string[];
  english: string[];
  image_names: string[];
  selectedImage: string | null;
}

function Haiku() {
  const [haikus, setHaikus] = useState<Haiku[]>([{
    japanese: ["仮の句よ", "まっさらながら", "花を呼ぶ"],
    english: [
      "A placeholder verse—",
      "even in a blank canvas,",
      "it beckons flowers.",
    ],
    image_names: [],
    selectedImage: null,
  }])
  const [activeIndex, setActiveIndex] = useState(0);
  const [isJustApplied, setIsJustApplied] = useState(false);

  const validateAndCorrectImageNames = (rawNames: string[] | undefined): string[] | null => {
    if (!rawNames || rawNames.length !== 3) {
      return null;
    }

    const correctedNames: string[] = [];
    const usedValidNames = new Set<string>();

    for (const name of rawNames) {
      if (VALID_IMAGE_NAMES.includes(name) && !usedValidNames.has(name)) {
        correctedNames.push(name);
        usedValidNames.add(name);
        if (correctedNames.length === 3) break;
      }
    }

    if (correctedNames.length < 3) {
      const availableFallbacks = VALID_IMAGE_NAMES.filter(name => !usedValidNames.has(name));
      for (let i = availableFallbacks.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [availableFallbacks[i], availableFallbacks[j]] = [availableFallbacks[j], availableFallbacks[i]];
      }

      while (correctedNames.length < 3 && availableFallbacks.length > 0) {
        const fallbackName = availableFallbacks.pop();
        if (fallbackName) {
          correctedNames.push(fallbackName);
        }
      }
    }

    while (correctedNames.length < 3 && VALID_IMAGE_NAMES.length > 0) {
      const fallbackName = VALID_IMAGE_NAMES[Math.floor(Math.random() * VALID_IMAGE_NAMES.length)];
      correctedNames.push(fallbackName);
    }

    return correctedNames.slice(0, 3);
  };

  useCopilotAction({
    name: "generate_haiku",
    parameters: [
      {
        name: "japanese",
        type: "string[]",
      },
      {
        name: "english",
        type: "string[]",
      },
      {
        name: "image_names",
        type: "string[]",
        description: "Names of 3 relevant images",
      },
    ],
    followUp: false,
    handler: async ({ japanese, english, image_names }: { japanese: string[], english: string[], image_names: string[] }) => {
      const finalCorrectedImages = validateAndCorrectImageNames(image_names);
      const newHaiku = {
        japanese: japanese || [],
        english: english || [],
        image_names: finalCorrectedImages || [],
        selectedImage: finalCorrectedImages?.[0] || null,
      };
      setHaikus(prev => [...prev, newHaiku]);
      setActiveIndex(haikus.length - 1);
      setIsJustApplied(true);
      setTimeout(() => setIsJustApplied(false), 600);
      return "Haiku generated.";
    },
    render: ({ args: generatedHaiku }: { args: Partial<GenerateHaiku> }) => {
      return (
        <HaikuCard generatedHaiku={generatedHaiku} setHaikus={setHaikus} haikus={haikus} />
      );
    },
  }, [haikus]);

  const generatedHaikus = useMemo(() => (
    haikus.filter((haiku) => haiku.english[0] !== "A placeholder verse—")
  ), [haikus]);

  const { isMobile } = useMobileView();

  return (
    <div className="flex h-full w-full">
      {/* Thumbnail List */}
      {Boolean(generatedHaikus.length) && !isMobile && (
        <div className="w-40 p-4 border-r border-gray-200 overflow-y-auto overflow-x-hidden max-w-1">
          {generatedHaikus.map((haiku, index) => (
            <div
              key={index}
              className={`haiku-card animated-fade-in mb-4 cursor-pointer ${index === activeIndex ? 'active' : ''}`}
              style={{
                width: '80px',
                transform: 'scale(0.2)',
                transformOrigin: 'top left',
                marginBottom: '-340px',
                opacity: index === activeIndex ? 1 : 0.5,
                transition: 'opacity 0.2s',
              }}
              onClick={() => setActiveIndex(index)}
            >
              {haiku.japanese.map((line, lineIndex) => (
                <div
                  className="flex items-start gap-2 mb-2 haiku-line"
                  key={lineIndex}
                >
                  <p className="text-2xl font-bold text-gray-600 w-auto">{line}</p>
                  <p className="text-xs font-light text-gray-500 w-auto">{haiku.english?.[lineIndex]}</p>
                </div>
              ))}
              {haiku.image_names && haiku.image_names.length === 3 && (
                <div className="mt-2 flex gap-2 justify-center">
                  {haiku.image_names.map((imageName, imgIndex) => (
                    <img
                      style={{
                        width: '110px',
                        height: '110px',
                        objectFit: 'cover',
                      }}
                      key={imageName}
                      src={`/images/${imageName}`}
                      alt={imageName || ""}
                      className="haiku-card-image w-12 h-12 object-cover"
                    />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Main Display */}
      <div className={`flex-1 flex items-center justify-center h-full ${
        isMobile 
          ? 'px-6' 
          : 'p-8'
      }`} style={{ marginLeft: isMobile ? '0' : '-48px' }}>
        <div className="haiku-stack w-full max-w-lg">
          {haikus.filter((_haiku: Haiku, index: number) => {
            if (haikus.length == 1) return true;
            else return index == activeIndex + 1;
          }).map((haiku, index) => (
            <div
              key={index}
              className={`haiku-card animated-fade-in ${isJustApplied && index === activeIndex ? 'applied-flash' : ''} ${index === activeIndex ? 'active' : ''}`}
              style={{
                zIndex: index === activeIndex ? haikus.length : index,
                transform: `translateY(${index === activeIndex ? '0' : `${(index - activeIndex) * 20}px`}) scale(${index === activeIndex ? '1' : '0.95'})`,
              }}
            >
              {haiku.japanese.map((line, lineIndex) => (
                <div
                  className={`flex items-start mb-4 haiku-line ${
                    isMobile 
                      ? 'flex-col gap-1' 
                      : 'gap-4'
                  }`}
                  key={lineIndex}
                  style={{ animationDelay: `${lineIndex * 0.1}s` }}
                >
                  <p className={`font-bold text-gray-600 w-auto ${
                    isMobile 
                      ? 'text-2xl leading-tight' 
                      : 'text-4xl'
                  }`}>
                    {line}
                  </p>
                  <p className={`font-light text-gray-500 w-auto ${
                    isMobile 
                      ? 'text-sm ml-2' 
                      : 'text-base'
                  }`}>
                    {haiku.english?.[lineIndex]}
                  </p>
                </div>
              ))}
              {haiku.image_names && haiku.image_names.length === 3 && (
                <div className={`flex justify-center ${
                  isMobile 
                    ? 'mt-4 gap-2 flex-wrap' 
                    : 'mt-6 gap-4'
                }`}>
                  {haiku.image_names.map((imageName, imgIndex) => (
                    <img
                      key={imageName}
                      src={`/images/${imageName}`}
                      alt={imageName || ""}
                      style={{
                        width: isMobile ? '90px' : '130px',
                        height: isMobile ? '90px' : '130px',
                        objectFit: 'cover',
                      }}
                      className={(haiku.selectedImage === imageName) ? `suggestion-card-image-focus` : `haiku-card-image`}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
