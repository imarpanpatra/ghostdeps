// The only place that talks to the model. Loopback only, by construction: the
// host is a constant, not configuration, so the generating half of a census
// cannot leak a prompt anywhere.

const HOST = 'http://127.0.0.1:11434';

export async function modelInfo(model) {
  const [{ version }, { models }] = await Promise.all([
    fetch(`${HOST}/api/version`).then((r) => r.json()),
    fetch(`${HOST}/api/tags`).then((r) => r.json()),
  ]);
  const found = models.find((m) => m.name === model);
  if (!found) throw new Error(`Model ${model} is not installed in Ollama.`);
  return { model, digest: found.digest, runtime: version, quantization: found.details?.quantization_level };
}

// Streams one completion. `shouldStop` lets the census hang up as soon as the
// install command is on screen, which saves most of the generation time.
export async function generate({ model, prompt, temperature = 0, seed = 1, numPredict = 300, shouldStop, onToken }) {
  const controller = new AbortController();
  const response = await fetch(`${HOST}/api/generate`, {
    method: 'POST',
    signal: controller.signal,
    body: JSON.stringify({
      model,
      prompt,
      stream: true,
      options: { temperature, seed, num_predict: numPredict },
    }),
  });
  if (!response.ok) throw new Error(`Ollama returned ${response.status}: ${await response.text()}`);

  const decoder = new TextDecoder();
  let text = '';
  let buffer = '';
  let stopped = false;
  try {
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.error) throw new Error(`Ollama: ${event.error}`);
        if (event.response) {
          text += event.response;
          onToken?.(event.response);
        }
      }
      if (shouldStop?.(text)) {
        stopped = true;
        controller.abort();
        break;
      }
    }
  } catch (error) {
    if (!stopped) throw error;
  }
  return { text, stopped };
}
