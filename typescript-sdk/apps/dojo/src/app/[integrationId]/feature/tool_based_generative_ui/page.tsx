"use client";
import { CopilotKit, useCopilotAction } from "@copilotkit/react-core";
import { CopilotKitCSSProperties, CopilotSidebar } from "@copilotkit/react-ui";
import { Dispatch, SetStateAction, useState } from "react";
import "@copilotkit/react-ui/styles.css";
import "./style.css";
import React, { useMemo } from "react";

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

  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      // agent lock to the relevant agent
      agent="tool_based_generative_ui"
    >
      <div
        className="min-h-full w-full flex items-center justify-center"
        style={
          {
            // "--copilot-kit-primary-color": "#222",
            // "--copilot-kit-separator-color": "#CCC",
          } as CopilotKitCSSProperties
        }
      >
        <Haiku />
        <CopilotSidebar
          defaultOpen={true}
          labels={{
            title: "Haiku Generator",
            initial: "I'm a haiku generator 👋. How can I help you?",
          }}
          clickOutsideToClose={false}
        />
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
    handler: async ({ japanese, english, image_names }) => {
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
    render: ({ args: generatedHaiku }) => {
      return (
        <HaikuCard generatedHaiku={generatedHaiku} setHaikus={setHaikus} haikus={haikus} />
      );
    },
  }, [haikus]);

  const generatedHaikus = useMemo(() => (
    haikus.filter((haiku) => haiku.english[0] !== "A placeholder verse—")
  ), [haikus]);

  return (
    <div className="flex h-screen w-full">

      {/* Thumbnail List */}
      {generatedHaikus.length && (
        <div className="w-40 p-4 border-r border-gray-200 overflow-y-auto overflow-x-hidden">
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
      {/* Add a margin to the left of margin-left: -48px; */}
      <div className="flex-1 p-8 flex items-center justify-center " style={{ marginLeft: '-48px' }}>
        <div className="haiku-stack">
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
              // onClick={() => setActiveIndex(index)}
            >
              {haiku.japanese.map((line, lineIndex) => (
                <div
                  className="flex items-start gap-4 mb-4 haiku-line"
                  key={lineIndex}
                  style={{ animationDelay: `${lineIndex * 0.1}s` }}
                >
                  <p className="text-4xl font-bold text-gray-600 w-auto">{line}</p>
                  <p className="text-base font-light text-gray-500 w-auto">{haiku.english?.[lineIndex]}</p>
                </div>
              ))}
              {haiku.image_names && haiku.image_names.length === 3 && (
                <div className="mt-6 flex gap-4 justify-center">
                  {haiku.image_names.map((imageName, imgIndex) => (
                    <img
                      key={imageName}
                      src={`/images/${imageName}`}
                      alt={imageName || ""}
                      style={{
                        width: '130px',
                        height: '130px',
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
