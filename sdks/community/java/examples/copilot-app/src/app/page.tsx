"use client";
import { CopilotSidebar } from "@copilotkit/react-ui";
import { useCoAgent } from "@copilotkit/react-core"; 

export default function Page() {
  const { state, setState } = useCoAgent<any>({ 
    name: "agent",
    // optionally provide a type-safe initial state
    initialState: { language: "spanish" }  
  });

  const toggleLanguage = () => {
    setState({ language: state.language === "english" ? "spanish" : "english" }); 
  };


  return (
    <main>
      <h1>Your App</h1>
      <p>Language: {state.language}</p> 
      <button onClick={toggleLanguage}>Toggle Language</button>

      <CopilotSidebar
          instructions={"You are an AI agent called 'Instructions'. You are assisting the user as best as you can. Answer in the best way possible given the data you have."}
            labels={{
              title: "Your Assistant",
              initial: "Hi! 👋 How can I assist you today?",
            }}/>
    </main>
  );
}