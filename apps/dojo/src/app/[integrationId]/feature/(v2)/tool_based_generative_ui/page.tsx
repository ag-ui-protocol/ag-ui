"use client";
import React, { useState } from "react";
import "@copilotkit/react-core/v2/styles.css";
import {
  useFrontendTool,
  useRenderTool,
  useConfigureSuggestions,
  CopilotSidebar,
} from "@copilotkit/react-core/v2";
import { z } from "zod";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/components/ui/carousel";
import { useURLParams } from "@/contexts/url-params-context";
import { CopilotKit } from "@copilotkit/react-core";

interface ToolBasedGenerativeUIProps {
  params: Promise<{
    integrationId: string;
  }>;
}

interface Haiku {
  japanese: string[];
  english: string[];
  image_name: string | null;
  gradient: string;
}

export default function ToolBasedGenerativeUI({
  params,
}: ToolBasedGenerativeUIProps) {
  const { integrationId } = React.use(params);
  const { chatDefaultOpen } = useURLParams();

  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      agent="tool_based_generative_ui"
    >
      <SidebarWithSuggestions defaultOpen={chatDefaultOpen} />
      <HaikuDisplay integrationId={integrationId} />
    </CopilotKit>
  );
}

function SidebarWithSuggestions({ defaultOpen }: { defaultOpen: boolean }) {
  useConfigureSuggestions({
    suggestions: [
      { title: "Nature Haiku", message: "Write me a haiku about nature." },
      { title: "Ocean Haiku", message: "Create a haiku about the ocean." },
      { title: "Spring Haiku", message: "Generate a haiku about spring." },
    ],
    available: "always",
  });

  return (
    <CopilotSidebar
      agentId="tool_based_generative_ui"
      defaultOpen={defaultOpen}
      labels={{
        modalHeaderTitle: "Haiku Generator",
      }}
    />
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
  "Mount_Fuji_Lake_Reflection_Cherry_Blossoms_Sakura_Spring.jpg",
];

const haikuSchema = z.object({
  japanese: z.array(z.string()).describe("3 lines of haiku in Japanese"),
  english: z
    .array(z.string())
    .describe("3 lines of haiku translated to English"),
  image_name: z
    .string()
    .describe(`One relevant image name from: ${VALID_IMAGE_NAMES.join(", ")}`),
  gradient: z.string().describe("CSS Gradient color for the background"),
});

function HaikuDisplay({ integrationId }: { integrationId: string }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [haikus, setHaikus] = useState<Haiku[]>([
    {
      japanese: ["仮の句よ", "まっさらながら", "花を呼ぶ"],
      english: [
        "A placeholder verse—",
        "even in a blank canvas,",
        "it beckons flowers.",
      ],
      image_name: null,
      gradient: "",
    },
  ]);

  const recordHaiku = React.useCallback((haiku: Haiku) => {
    setHaikus((previous) => {
      const key = haiku.japanese.join("\n");
      if (previous.some((item) => item.japanese.join("\n") === key)) {
        return previous;
      }
      return [
        haiku,
        ...previous.filter(
          (item) => item.english[0] !== "A placeholder verse—",
        ),
      ];
    });
    setActiveIndex(0);
  }, []);

  return (
    <div className="relative flex items-center justify-center h-full w-full">
      {integrationId === "microsoft-agent-framework-python" ? (
        <MicrosoftAgentFrameworkHaikuTool onGenerated={recordHaiku} />
      ) : (
        <FrontendHaikuTool onGenerated={recordHaiku} />
      )}
      <div className="px-20 py-12 w-full max-w-4xl">
        <Carousel className="w-full" data-testid="haiku-carousel">
          <CarouselContent>
            {haikus.map((haiku, index) => (
              <CarouselItem key={index} data-testid={`carousel-item-${index}`}>
                <HaikuCard haiku={haiku} />
              </CarouselItem>
            ))}
          </CarouselContent>
          {haikus.length > 1 && (
            <>
              <CarouselPrevious />
              <CarouselNext />
            </>
          )}
        </Carousel>
      </div>
    </div>
  );
}

function FrontendHaikuTool({
  onGenerated,
}: {
  onGenerated: (haiku: Haiku) => void;
}) {
  useFrontendTool(
    {
      agentId: "tool_based_generative_ui",
      name: "generate_haiku",
      parameters: haikuSchema,
      followUp: false,
      handler: async ({
        japanese,
        english,
        image_name,
        gradient,
      }: {
        japanese: string[];
        english: string[];
        image_name: string;
        gradient: string;
      }) => {
        const newHaiku: Haiku = {
          japanese: japanese || [],
          english: english || [],
          image_name: image_name || null,
          gradient: gradient || "",
        };
        onGenerated(newHaiku);
        return "Haiku generated!";
      },
      render: ({ args }: { args: Partial<Haiku> }) => {
        if (!args.japanese) return <></>;
        return <HaikuCard haiku={args as Haiku} />;
      },
    },
    [onGenerated],
  );

  return null;
}

function MicrosoftAgentFrameworkHaikuTool({
  onGenerated,
}: {
  onGenerated: (haiku: Haiku) => void;
}) {
  useRenderTool(
    {
      agentId: "tool_based_generative_ui",
      name: "generate_haiku",
      parameters: haikuSchema,
      render: ({ parameters }: any) => (
        <RenderedHaiku parameters={parameters} onGenerated={onGenerated} />
      ),
    },
    [onGenerated],
  );

  return null;
}

function RenderedHaiku({
  parameters,
  onGenerated,
}: {
  parameters: Partial<Haiku>;
  onGenerated: (haiku: Haiku) => void;
}) {
  const complete =
    parameters.japanese?.length === 3 &&
    parameters.english?.length === 3 &&
    typeof parameters.image_name === "string" &&
    typeof parameters.gradient === "string";

  React.useEffect(() => {
    if (complete) {
      onGenerated(parameters as Haiku);
    }
  }, [complete, onGenerated, parameters]);

  return complete ? <HaikuCard haiku={parameters} /> : <></>;
}

function HaikuCard({ haiku }: { haiku: Partial<Haiku> }) {
  return (
    <div
      data-testid="haiku-card"
      style={{ background: haiku.gradient }}
      className="relative bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-900 dark:to-blue-950 rounded-2xl my-6 p-8 max-w-2xl border border-slate-200 dark:border-slate-700 overflow-hidden"
    >
      {/* Decorative background elements */}
      <div className="absolute top-0 right-0 w-64 h-64 bg-gradient-to-br from-blue-400/10 to-purple-400/10 rounded-full blur-3xl -z-0" />
      <div className="absolute bottom-0 left-0 w-48 h-48 bg-gradient-to-tr from-indigo-400/10 to-pink-400/10 rounded-full blur-3xl -z-0" />

      {/* Haiku Text */}
      <div className="relative z-10 flex flex-col items-center space-y-6">
        {haiku.japanese?.map((line, index) => (
          <div
            key={index}
            className="flex flex-col items-center text-center space-y-2 animate-in fade-in slide-in-from-bottom-4"
            style={{ animationDelay: `${index * 100}ms` }}
          >
            <p
              data-testid="haiku-japanese-line"
              className="font-serif font-bold text-4xl md:text-5xl bg-gradient-to-r from-slate-800 to-slate-600 dark:from-slate-100 dark:to-slate-300 bg-clip-text text-transparent tracking-wide"
            >
              {line}
            </p>
            <p
              data-testid="haiku-english-line"
              className="font-light text-base md:text-lg text-slate-600 dark:text-slate-400 italic max-w-md"
            >
              {haiku.english?.[index]}
            </p>
          </div>
        ))}
      </div>

      {/* Image */}
      {haiku.image_name && (
        <div className="relative z-10 mt-8 pt-8 border-t border-slate-200 dark:border-slate-700">
          <div className="relative group overflow-hidden rounded-2xl shadow-xl">
            <img
              data-testid="haiku-image"
              src={`/images/${haiku.image_name}`}
              alt={haiku.image_name}
              className="object-cover w-full h-64 md:h-80 transform transition-transform duration-500 group-hover:scale-105"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
          </div>
        </div>
      )}
    </div>
  );
}
