import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";

export const config = {
  runtime: "edge",
};

interface Label {
  //id: string;
  name: string;
  //color: string;
  description: string;
}

interface LabelAction {
  label: string;
  replacedLabel: string;
  processLabel: string;
  action: string;
  prompts: string[];
  description: string | undefined;
}

interface LabelPayload {
  pageId: string;
  labels: Label[];
}

interface Article {
  id: string;
  content: string;
  title: string;
  labels: Label[];
  highlights: Array<{ id: string; type: string }>;
  existingNote: { id: string; type: string } | undefined;
}

interface PagePayload {
  id: string;
  userId: string;
  state: "SUCCEEDED" | string;
  originalUrl: string;
  downloadUrl: string | null;
  slug: string;
  title: string;
  author: string | null;
  description: string;
  savedAt: string;
  createdAt: string;
  publishedAt: string;
  archivedAt: string | null;
  deletedAt: string | null;
  readAt: string | null;
  updatedAt: string;
  itemLanguage: string;
  wordCount: number;
  siteName: string;
  siteIcon: string;
  readingProgressLastReadAnchor: number;
  readingProgressHighestReadAnchor: number;
  readingProgressTopPercent: number;
  readingProgressBottomPercent: number;
  thumbnail: string;
  itemType: "WEBSITE" | string;
  uploadFileId: string | null;
  contentReader: "WEB" | string;
  subscription: object | null;
  directionality: "LTR" | "RTL";
  note: string | null;
  recommenderNames: string[];
  folder: string;
  labelNames: string[];
  highlightAnnotations: object[];
  seenAt: string | null;
  topic: string | null;
  digestedAt: string | null;
  score: number | null;
  previewContent: string;
}

// New types for the webhook payload
interface WebhookLabel {
  id: string;
  name: string;
  color: string;
}

interface WebhookLabelPayload {
  labels: WebhookLabel[];
  pageId: string;
}

// Update the existing WebhookPayload interface
interface WebhookPayload {
  action: string;
  userId: string;
  label?: WebhookLabelPayload;
  page?: PagePayload;
}

export default async (req: Request): Promise<Response> => {
  const requestId = uuidv4(); // Generate a unique ID for this request
  console.log(`[${requestId}] Starting request processing`);

  try {
    const annotateLabel = process.env["OMNIVORE_ANNOTATE_LABEL"] ?? "do";
    console.log(`[${requestId}] Annotate label: ${annotateLabel}`);

    const body: WebhookPayload = (await req.json()) as WebhookPayload;
    console.log(
      `[${requestId}] Received webhook payload:`,
      JSON.stringify(body)
    );

    // Update the labels handling
    const labels = (body.label?.labels || []).filter(
      (label): label is WebhookLabel =>
        !!label && typeof label === "object" && "name" in label
    );

    console.log(`[${requestId}] Filtered labels:`, JSON.stringify(labels));

    if (labels.length === 0) {
      console.log(`[${requestId}] No labels found in the webhook payload.`);
      return new Response(`No labels found in the webhook payload.`, {
        status: 400,
      });
    }

    const matchingLabels = labels
      .filter(
        (label) =>
          label.name === annotateLabel ||
          label.name.startsWith(`${annotateLabel}:`)
      )
      .map((label) => label.name);

    console.log(
      `[${requestId}] Matching labels:`,
      JSON.stringify(matchingLabels)
    );

    if (matchingLabels.length === 0) {
      console.log(`[${requestId}] No '${annotateLabel}' labels found.`);
      return new Response(
        `No '${annotateLabel}' labels found. Expected at least one '${annotateLabel}' or '${annotateLabel}:*' label.`,
        { status: 400 }
      );
    }

    console.log(`Found matching labels: ${matchingLabels.join(", ")}`);

    // You can now use matchingLabels array for further processing
    // For example, to check for specific labels:
    const hasBaseLabel = matchingLabels.includes(annotateLabel);
    const hasTask = matchingLabels.includes(`${annotateLabel}:task`);
    const hasTranscription = matchingLabels.includes(
      `${annotateLabel}:transcription`
    );
    const hasCompletion = matchingLabels.includes(
      `${annotateLabel}:completion`
    );

    console.log(
      `hasBaseLabel: ${hasBaseLabel}, hasTask: ${hasTask}, hasTranscription: ${hasTranscription}, hasCompletion: ${hasCompletion}`
    );

    const articleId = body.label?.pageId;
    if (!articleId) {
      throw new Error("No article ID found in the webhook payload.");
    }

    const omnivoreHeaders = {
      "Content-Type": "application/json",
      Authorization: process.env["OMNIVORE_API_KEY"] ?? "",
    };

    const article = await getArticle(articleId, omnivoreHeaders);

    const labelActions = getLabelAction(matchingLabels, article, annotateLabel);

    const model = process.env["OPENAI_MODEL"] || "gpt-4o-2024-08-06";
    const settings = process.env["OPENAI_SETTINGS"] || `{"model":"${model}"}`;

    console.log("labelAction: ", labelActions);
    const { found, action } = resolvedLabelActions("tags", labelActions);
    console.log("Found 'tags' action:", found);
    console.log("Matching LabelAction:", action);
    if (found) {
      const currentLabelActions = action;

      console.log("TAGS currentLabelActions: ", action);

      const articleLabelsPrompt = labelsToPrompt(
        article.labels,
        annotateLabel,
        "Existing article tags: ",
        true
      );

      const chatgptExample = {
        tags: [
          {
            name: "Tag Name",
            description: "Really short tag description or an empty string",
          },
          {
            name: "Gender and Education",
            description: "",
          },
          {
            name: "Inclusive Knowledge Preservation",
            description:
              "Accessibility and long-term preservation of human knowledge",
          },
        ],
      };

      const allLabels = await getAllLabelsFromOmnivore(omnivoreHeaders);

      console.log("allLabels: ", allLabels);
      console.log("article.labels: ", article.labels);

      const allLabelsPrompt = labelsToPrompt(
        allLabels,
        annotateLabel,
        "All labels in Omnivore: ",
        true
      );

      const doTagsPrompt = `Generate a list of useful tags that could be added to this article. Proved them as a JSON array of objects with name and description properties.
      ONLY respond with the JSON array.
      Example: ${JSON.stringify(chatgptExample, null, 2)}
      Please keep with the existing taxonomy and use the same language as the existing tags. Don’t have multiple tags referring to the same topic. Please reuse existing tags if they are similar.
      Although as I'm an artist, I'm always looking for meaningful connections and metaphors. So if a tag falls outside of the existing structure but makes sense in the context of the article, add it as a new tag.
      ONLY respond with the JSON array!`;

      console.log("doTagsPrompt: ", doTagsPrompt);

      const prompt = arrayToPromptGenerator([
        doTagsPrompt,
        ...currentLabelActions.prompts,
        articleLabelsPrompt,
        allLabelsPrompt,
      ]);

      console.log("prompt: ", prompt);

      const openai = new OpenAI();
      const completionResponse = await openai.chat.completions.create({
        ...JSON.parse(settings),
        messages: [{ role: "user", content: prompt }],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "tag_list",
            strict: true,
            schema: {
              type: "object",
              properties: {
                tags: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      name: {
                        type: "string",
                      },
                      description: {
                        type: "string",
                      },
                    },
                    required: ["name", "description"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["tags"],
              "additionalProperties": false
            },
          },
        },
      });

      // const generatedTags = completionResponse.choices[0].message.content
      //   ?.trim()
      //   .split("\n")
      //   .map((tag) => tag.trim())
      //   .filter(
      //     (tag) =>
      //       tag && !article.labels.some((existing) => existing.name === tag)
      //   );

      const response = completionResponse.choices[0].message.content;

      if (!response) {
        console.log(
          "No response from OpenAI.",
          completionResponse.choices[0].message.content
        );
        return new Response(`No response from OpenAI.`, { status: 500 });
      }

      const generatedTags = JSON.parse(response);
      console.log('generatedTags', generatedTags)

      if (!generatedTags || generatedTags.length === 0) {
        console.log(
          "No new tags generated.",
          completionResponse.choices[0].message.content
        );
        return new Response(`No new tags generated.`, { status: 200 });
      }


      const newLabels = [
        ...article.labels,
        ...generatedTags.tags,
        {name: currentLabelActions.replacedLabel},
      ];

      await addLabelsToOmnivoreArticle(article.id, newLabels, omnivoreHeaders);

      return new Response(
        `New tags added to the article and action updated to did: action.`,
        { status: 200 }
      );
    } else if (hasOpenLabelActions(labelActions).hasOpen) {
      const currentLabelAction = hasOpenLabelActions(labelActions).nextAction;
      console.log("Running catchall with: ", currentLabelAction?.action);
      console.log("currentLabelAction: ", currentLabelAction);
      if (!currentLabelAction) {
        return new Response(`No current label action found.`, { status: 400 });
      }
      const prompt = arrayToPromptGenerator([...currentLabelAction.prompts]);

      const openai = new OpenAI();
      const completionResponse = await openai.chat.completions.create({
        ...JSON.parse(settings),
        messages: [{ role: "user", content: prompt }],
      });

      const generatedResponse = completionResponse.choices[0].message.content
        ?.trim()
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"');

      if (!generatedResponse) {
        console.log(
          "No generated response from OpenAI.",
          completionResponse.choices[0].message.content
        );
        return new Response(`No generated response from OpenAI.`, {
          status: 500,
        });
      }

      await applyAnnotationToOmnivoreArticle(
        article.id,
        generatedResponse,
        omnivoreHeaders,
        article.existingNote
      );
      return new Response(`Annotation applied to the article.`, {
        status: 200,
      });
    } else {
      console.log("Unhandled action: ", body.action);
      return new Response(`Unhandled action: ${body.action}`, { status: 400 });
    }
  } catch (error) {
    console.error(`[${requestId}] Error processing Omnivore webhook:`, error);
    return new Response(
      `Error processing Omnivore webhook: ${(error as Error).message}`,
      { status: 500 }
    );
  }
};

const resolvedLabelActions = (
  currentAction: string,
  myLabelAction: LabelAction[]
): { found: boolean; action: LabelAction | null } => {
  const matchingAction = myLabelAction.find(
    (label) => label.action === currentAction
  );

  return {
    found: !!matchingAction,
    action: matchingAction || null,
  };
};

const hasOpenLabelActions = (myLabelAction: LabelAction[]) => {
  const undoneAction = myLabelAction.find((label) => label.done === false);
  return {
    hasOpen: myLabelAction.some((label) => label.done === false),
    nextAction: undoneAction || null,
  };
};

async function getArticle(
  articleId: string,
  omnivoreHeaders: Record<string, string>
): Promise<Article> {
  interface FetchQueryResponse {
    data: {
      article: {
        article: {
          content: string;
          title: string;
          labels: Array<{
            name: string;
            description: string;
          }>;
          highlights: Array<{
            id: string;
            type: string;
          }>;
        };
      };
    };
  }

  let fetchQuery = {
    query: `query Article {
  article(
    slug: "${articleId}"
    username: "."
    format: "markdown"
    ) {
      ... on ArticleSuccess {
        article {
          title
          content
          labels {
            name
            description
            id
            color
          }
          highlights(input: { includeFriends: false }) {
            id
            shortId
            user {
                id
                name
                createdAt
            }
            type
          }
        }
      }
    }
  }`,
  };

  const omnivoreRequest = await fetch(
    "https://api-prod.omnivore.app/api/graphql",
    {
      method: "POST",
      headers: omnivoreHeaders,
      body: JSON.stringify(fetchQuery),
      redirect: "follow",
    }
  );
  const omnivoreResponse = (await omnivoreRequest.json()) as FetchQueryResponse;

  const {
    data: {
      article: {
        article: {
          content: articleContent,
          title: articleTitle,
          labels: articleLabels,
          highlights,
        },
      },
    },
  } = omnivoreResponse;

  let article = {
    id: articleId,
    title: articleTitle,
    labels: articleLabels,
    highlights,
    existingNote: highlights.find(({ type }) => type === "NOTE"),
    content: articleContent,
  };
  console.log("Loaded article: ", article);
  return article;
}

function arrayToPromptGenerator(array: (string | null)[]): string {
  return array
    .filter((item): item is string => item !== null)
    .map((item) => `- ${item}`)
    .join("\n");
}

function getLabelDescription(
  labelName: string,
  labels: Label[]
): string | undefined {
  const label = labels.find((l) => l.name === labelName);
  return label?.description;
}

function getLabelAction(
  matchingLabels: string[],
  article: Article,
  annotateLabel: string
): LabelAction[] {
  return matchingLabels.map((label) => {
    const description = getLabelDescription(label, article.labels);
    const promptWithFallback =
      description ||
      process.env["OPENAI_PROMPT"] ||
      "Return a tweet-length TL;DR of the following article.";

    const promptBodyArray = (promptWithFallback: string): string[] => [
      promptWithFallback,
      `Article title: ${article.title}`,
      `Article content: ${article.content}`,
      article.existingNote ? `Existing note: ${article.existingNote}` : "",
    ];

    return {
      label: label,
      replacedLabel: label.replace(`${annotateLabel}:`, "did:"),
      processLabel: label.split(":")[0],
      action: label.split(":")[1],
      description,
      prompts: promptBodyArray(promptWithFallback),
    };
  });
}

function labelsToPrompt(
  labels: Label[],
  annotateLabel: string,
  prePrompt: string,
  returnJson: boolean = true
): string | null {
  if (labels.length === 0) {
    console.log("No labels found.");
    return null;
  }

  const labelsWithoutAnnotationLabel = labels.filter(
    (label) => !label.name.startsWith(annotateLabel)
  );

  if (labelsWithoutAnnotationLabel.length === 0) {
    console.log("No labels without annotation label found.");
    return null;
  }

  if (returnJson) {
    const json = labelsWithoutAnnotationLabel.map((label) => ({
      name: label.name,
      description: label.description || "",
    }));
    console.log("json: ", json);
    return `${prePrompt} ${JSON.stringify(json, null, 2)}`;
  } else {
    const labelString = labelsWithoutAnnotationLabel
      .map((label) => label.name)
      .join(", ");
    console.log("labelString: ", labelString);
    return `${prePrompt} ${labelString}`;
  }
}

async function getAllLabelsFromOmnivore(
  omnivoreHeaders: Record<string, string>
): Promise<Label[]> {
  const labelsQuery = {
    query: `query GetLabels{
          labels {
            ... on LabelsSuccess {
              labels {
                id, 
                name, 
                color,
                description,
                createdAt, 
                position, 
                internal
              }
            }
            ... on LabelsError {
              errorCodes
            }
          }
        }
    `,
  };

  try {
    const response = await fetch("https://api-prod.omnivore.app/api/graphql", {
      method: "POST",
      headers: omnivoreHeaders,
      body: JSON.stringify(labelsQuery),
    });

    const data = await response.json();

    if (data.data && data.data.labels && data.data.labels.labels) {
      console.log("data.data.labels.labels: ", data.data.labels.labels);
      return data.data.labels.labels;
    } else if (data.data && data.data.labels && data.data.labels.errorCodes) {
      console.log("data.data.labels.errorCodes: ", data.data.labels.errorCodes);
      throw new Error(
        `Failed to fetch labels: ${data.data.labels.errorCodes.join(", ")}`
      );
    } else {
      throw new Error("Unexpected response structure");
    }
  } catch (error) {
    console.error("Error fetching labels:", error);
    throw error;
  }
}

async function setLabels(
  pageId: string,
  labels: Label[],
  omnivoreHeaders: Record<string, string>
): Promise<void> {
  console.log("Setting labels:", labels);
  const mutation = `mutation SetLabels($input: SetLabelsInput!) {
    setLabels(input: $input) {
      ... on SetLabelsSuccess {
        labels {
          ...LabelFields
        }
      }
      ... on SetLabelsError {
        errorCodes
      }
    }
  }
  
  fragment LabelFields on Label {
    id
    name
    color
    description
    createdAt
  }`;

  const labelIds = labels.map((it) => it.id);

  const response = await fetch("https://api-prod.omnivore.app/api/graphql", {
    method: "POST",
    headers: {
      ...omnivoreHeaders,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: mutation,
      variables: { input: { pageId, labelIds } },
    }),
  });

  const result = await response.json();

  if (result.errors) {
    throw new Error(`Failed to set labels: ${result.errors[0].message}`);
  }

  console.log("Labels set successfully:", result.data.setLabels);
}

let baseFragment = `
  fragment HighlightFields on Highlight {
    id
    type
    shortId
    quote
    prefix
    suffix
    patch
    color
    annotation
    createdByMe
    createdAt
    updatedAt
    sharedAt
    highlightPositionPercent
    highlightPositionAnchorIndex
    labels {
      id
      name
      color
      createdAt
    }
  `;

function applyAnnotationToOmnivoreArticle(
  articleId: string,
  annotation: string,
  omnivoreHeaders: Record<string, string>,
  existingNote: { id: string; type: string } | null | undefined
) {
  if (existingNote) {
    return updateAnnotationInOmnivoreArticle(
      articleId,
      annotation,
      omnivoreHeaders,
      existingNote
    );
  } else {
    return addAnnotationToOmnivoreArticle(
      articleId,
      annotation,
      omnivoreHeaders
    );
  }
}

async function updateAnnotationInOmnivoreArticle(
  articleId: string,
  annotation: string,
  omnivoreHeaders: Record<string, string>,
  existingNote: { id: string; type: string }
) {
  if (!existingNote) {
    return new Response(
      `No existing note found in Omnivore article: ${articleId}`,
      { status: 404 }
    );
  }

  try {
    let mutationQuery: {
      query: string;
      variables: {
        input: {
          highlightId?: string;
          annotation: string;
          type?: string;
          id?: string;
          shortId?: string;
          articleId?: string;
        };
      };
    };

    // Omnivore UI only shows one highlight note per article so
    // if we have an existing note, update it; otherwise, create a new one

    mutationQuery = {
      query: `mutation UpdateHighlight($input: UpdateHighlightInput!) {
      updateHighlight(input: $input) {
        ... on UpdateHighlightSuccess {
          highlight {
            ...HighlightFields
          }
        }
        ... on UpdateHighlightError {
          errorCodes
        }
      }
    }${baseFragment}`,
      variables: {
        input: {
          highlightId: existingNote.id,
          annotation: annotation,
        },
      },
    };

    const OmnivoreAnnotationRequest = await fetch(
      "https://api-prod.omnivore.app/api/graphql",
      {
        method: "POST",
        headers: omnivoreHeaders,
        body: JSON.stringify(mutationQuery),
      }
    );
    const OmnivoreAnnotationResponse =
      (await OmnivoreAnnotationRequest.json()) as { data: unknown };
    console.log(
      `Article annotation updated to article "${articleId}" (ID: ${articleId}): ${JSON.stringify(
        OmnivoreAnnotationResponse.data
      )}`,
      `Used this GraphQL query: ${JSON.stringify(mutationQuery)}`
    );

    return new Response(`Article annotation updated.`);
  } catch (error) {
    return new Response(
      `Error adding annotation to Omnivore article: ${
        (error as Error).message
      }`,
      { status: 500 }
    );
  }
}
async function addAnnotationToOmnivoreArticle(
  articleId: string,
  annotation: string,
  omnivoreHeaders: Record<string, string>
) {
  try {
    let mutationQuery: {
      query: string;
      variables: {
        input: {
          highlightId?: string;
          annotation: string;
          type?: string;
          id?: string;
          shortId?: string;
          articleId?: string;
        };
      };
    };

    const id = uuidv4();
    const shortId = id.substring(0, 8);

    mutationQuery = {
      query: `mutation CreateHighlight($input: CreateHighlightInput!) {
  createHighlight(input: $input) {
    ... on CreateHighlightSuccess {
      highlight {
        ...HighlightFields
      }
    }
    ... on CreateHighlightError {
      errorCodes
    }
  }
}${baseFragment}`,
      variables: {
        input: {
          type: "NOTE",
          id: id,
          shortId: shortId,
          articleId: articleId,
          annotation: annotation,
        },
      },
    };

    const OmnivoreAnnotationRequest = await fetch(
      "https://api-prod.omnivore.app/api/graphql",
      {
        method: "POST",
        headers: omnivoreHeaders,
        body: JSON.stringify(mutationQuery),
      }
    );
    const OmnivoreAnnotationResponse =
      (await OmnivoreAnnotationRequest.json()) as { data: unknown };
    console.log(
      `Article annotation added to article "${articleId}" (ID: ${articleId}): ${JSON.stringify(
        OmnivoreAnnotationResponse.data
      )}`,
      `Used this GraphQL query: ${JSON.stringify(mutationQuery)}`
    );

    return new Response(`Article annotation added.`);
  } catch (error) {
    return new Response(
      `Error adding annotation to Omnivore article: ${
        (error as Error).message
      }`,
      { status: 500 }
    );
  }
}

async function addLabelsToOmnivoreArticle(
  articleId: string,
  labels: string[],
  omnivoreHeaders: Record<string, string>
) {

  console.log('addLabelsToOmnivoreArticle', labels)

  // STEP 3: Add new tags to the article
  const addLabelsMutation = {
    query: `mutation SetLabels($input: SetLabelsInput!) {
      setLabels(input: $input) {
        ... on SetLabelsSuccess {
          labels {
            name
          }
        }
        ... on SetLabelsError {
          errorCodes
        }
      }
    }`,
    variables: {
      input: {
        articleID: articleId,
        labels: labels,
      },
    },
  };

  const addLabelsRequest = await fetch(
    "https://api-prod.omnivore.app/api/graphql",
    {
      method: "POST",
      headers: omnivoreHeaders,
      body: JSON.stringify(addLabelsMutation),
    }
  );
  const addLabelsResponse = await addLabelsRequest.json();
  console.log(
    `Labels added to article "${articleId}" (ID: ${articleId}):`,
    addLabelsResponse
  );

  return new Response(
    `New tags added to the article and action updated to did: action.`
  );
}
