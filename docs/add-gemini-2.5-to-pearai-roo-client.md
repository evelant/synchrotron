Need to add the following to the files for the extension in the app package:


```json
"gemini-2.5-pro-exp-03-25":{maxTokens:65536,contextWindow:2097152,supportsImages:!0,supportsPromptCache:!1,inputPrice:0,outputPrice:0},
```

Two files: 

../../../../../../Applications/PearAI-Early.app/Contents/Resources/app/extensions/pearai.pearai-roo-cline-3.10.2/webview-ui/build/assets/index.js
../../../../../../Applications/PearAI-Early.app/Contents/Resources/app/extensions/pearai.pearai-roo-cline-3.10.2/dist/extension.js