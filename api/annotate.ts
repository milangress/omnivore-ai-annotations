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
  done: boolean;
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
};

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
  try {
    const annotateLabel = process.env["OMNIVORE_ANNOTATE_LABEL"] ?? "do";

    const body: WebhookPayload = (await req.json()) as WebhookPayload;
    console.log("Received webhook payload:", body);

    // Update the labels handling
    const labels = (body.label?.labels || [])
      .filter((label): label is WebhookLabel => !!label && typeof label === 'object' && 'name' in label)
    
    if (labels.length === 0) {
      return new Response(`No labels found in the webhook payload.`, { status: 400 });
    }
    
    const matchingLabels = labels
      .filter(label => 
        label.name === annotateLabel || 
        label.name.startsWith(`${annotateLabel}:`)
      )
      .map(label => label.name);

    if (matchingLabels.length === 0) {
      return new Response(`No '${annotateLabel}' labels found. Expected at least one '${annotateLabel}' or '${annotateLabel}:*' label.`, { status: 400 });
    }

    console.log(`Found matching labels: ${matchingLabels.join(', ')}`);

    // You can now use matchingLabels array for further processing
    // For example, to check for specific labels:
    const hasBaseLabel = matchingLabels.includes(annotateLabel);
    const hasTask = matchingLabels.includes(`${annotateLabel}:task`);
    const hasTranscription = matchingLabels.includes(`${annotateLabel}:transcription`);
    const hasCompletion = matchingLabels.includes(`${annotateLabel}:completion`);

    console.log(`hasBaseLabel: ${hasBaseLabel}, hasTask: ${hasTask}, hasTranscription: ${hasTranscription}, hasCompletion: ${hasCompletion}`);

    const articleId = body.label?.pageId;
    if (!articleId) {
      throw new Error("No article ID found in the webhook payload.");
    }

    const omnivoreHeaders = {
      "Content-Type": "application/json",
      Authorization: process.env["OMNIVORE_API_KEY"] ?? "",
    };

    const article = await getArticle(articleId, omnivoreHeaders);



    function getLabelAction(matchingLabels: string[], article: Article): LabelAction[] {
      return matchingLabels.map(label => {
        const description = getLabelDescription(label, article.labels);
        const promptWithFallback = description || process.env["OPENAI_PROMPT"] || "Return a tweet-length TL;DR of the following article.";

        const promptBodyArray = (promptWithFallback: string) :string[] => [
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
          done: false,
        }
      });
    }

    const labelActions = getLabelAction(matchingLabels, article);

    const model = process.env["OPENAI_MODEL"] || "gpt-4-turbo-preview";
    const settings = process.env["OPENAI_SETTINGS"] || `{"model":"${model}"}`;

    const openai = new OpenAI();

    const resolvedLabelActions = (currentAction: string) => {
      const labelAction = labelActions.find(label => {
        label.action === currentAction && label.done === false
      })
      return labelAction
    }
    const hasOpenLabelActions = () => {
      const undoneAction = labelActions.find(label => label.done === false);
      return {
        hasOpen: labelActions.some(label => label.done === false),
        nextAction: undoneAction || null
      };
    }
  


    const currentLabelActions = resolvedLabelActions("tags");
    // Handle different 'do:' actions 
    if (currentLabelActions) {
      console.log("currentLabelActions: ", currentLabelActions);

      const articleLabelsPrompt = labelsToPrompt(
        article.labels,
        annotateLabel,
        "Existing article tags: ",
        true
      );

      const chatgptExample = `tags = [
        {
          "name": "Tag Name",
          "description": "Really short tag description or an empty string"
        },
        {
          "name": "Gender and Education",
          "description": ""
        },
        {
          "name": "Inclusive Knowledge Preservation",
          "description": "Accessibility and long-term preservation of human knowledge"
        }
      ]`;

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
      Example: ${JSON.stringify(chatgptExample)}
      Please keep with the existing taxonomy and use the same language as the existing tags. Don’t have multiple tags referring to the same topic. Please reuse existing tags if they are similar.
      Although as I'm an artist, I'm always looking for meaningful connections and metaphors. So if a tag falls outside of the existing structure but makes sense in the context of the article, add it as a new tag.
      ONLY respond with the JSON array!`;
      const prompt = arrayToPromptGenerator([
        doTagsPrompt,
        ...currentLabelActions.prompts,
        articleLabelsPrompt,
        allLabelsPrompt,
      ]);

      console.log("prompt: ", prompt);

      const completionResponse = await openai.chat.completions.create({
        ...JSON.parse(settings),
        messages: [{ role: "user", content: prompt }],
        response_format: { 
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              tags: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: {
                      type: "string"
                    },
                    description: {
                      type: "string"
                    }
                  },
                  required: ["name", "description"],
                  additionalProperties: false
                }
              }
            },
            required: ["tags"]
          }
        }
      });

      const generatedTags = completionResponse.choices[0].message.content
        ?.trim()
        .split("\n")
        .map((tag) => tag.trim())
        .filter(
          (tag) =>
            tag && !article.labels.some((existing) => existing.name === tag)
        );

      if (!generatedTags || generatedTags.length === 0) {
        console.log(
          "No new tags generated.",
          completionResponse.choices[0].message.content
        );
        return new Response(`No new tags generated.`, { status: 200 });
      }

      console.log(`Generated tags: ${generatedTags.join(", ")}`);

      const newLabels = [
        ...article.labels.map((label) => label.name),
        ...generatedTags,
        currentLabelActions.replacedLabel,
      ];

      await addLabelsToOmnivoreArticle(
        article.id,
        newLabels,
        omnivoreHeaders
      );

      return new Response(
        `New tags added to the article and action updated to did: action.`,
        { status: 200 }
      );
    } 
    else if (hasOpenLabelActions().hasOpen) {
      const currentLabelAction = hasOpenLabelActions().nextAction;
      console.log("currentLabelAction: ", currentLabelAction);
      if (!currentLabelAction) {
        return new Response(`No current label action found.`, { status: 400 });
      }
      const prompt = arrayToPromptGenerator([...currentLabelAction.prompts]);

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
    return new Response(
      `Error processing Omnivore webhook: ${(error as Error).message}`,
      { status: 500 }
    );
  }
};

async function getArticle(articleId: string, omnivoreHeaders: Record<string, string>): Promise<Article> {

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
  const omnivoreResponse =
    (await omnivoreRequest.json()) as FetchQueryResponse;

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
    content: articleContent,
    title: articleTitle,
    labels: articleLabels,
    highlights,
    existingNote: highlights.find(({ type }) => type === "NOTE")
  }
  return article;
}

function arrayToPromptGenerator(array: (string | null)[]): string {
  return array
    .filter((item): item is string => item !== null && item.trim() !== "")
    .map((item) => `- ${item}`)
    .join("\n");
}

function getLabelDescription(labelName: string, labels: Label[]): string | undefined {
  const label = labels.find(l => l.name === labelName);
  return label?.description;
}

function labelsToPrompt(
  labels: Label[],
  annotateLabel: string,
  prePrompt: string,
  returnJson: boolean = false
): string | null {
  if (labels.length === 0) {
    return null;
  }
  const labelsWithoutAnnotationLabel = labels.filter(
    (label) => label.name.split(":")[0] !== annotateLabel
  );
  if (returnJson) {
    const json = labelsWithoutAnnotationLabel.map((label) => ({
      name: label.name,
      description: label.description || ""
    }));
    return JSON.stringify(json);
  } else {  
    const labelString = labelsWithoutAnnotationLabel
      .map((label) => label.name)
      .join(", ");
    const existingArticleTagsPrompt = `${prePrompt} ${labelString}`;
    return existingArticleTagsPrompt;
  }
}

async function getAllLabelsFromOmnivore(
  omnivoreHeaders: Record<string, string>
): Promise<Label[]> {
  const labelsQuery = {
    query: `
      query {
        labels {
          ... on LabelsSuccess {
            labels {
              id
              name
              color
              description
              createdAt
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
      return data.data.labels.labels;
    } else if (data.data && data.data.labels && data.data.labels.errorCodes) {
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