Rails.application.routes.draw do
  post "/", to: "ag_ui#run"
end
