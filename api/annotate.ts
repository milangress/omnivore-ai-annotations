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

interface LabelPayload {
  pageId: string;
  labels: Label[];
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

interface WebhookPayload {
  action: string;
  label?: LabelPayload;
  page?: PagePayload;
}

export default async (req: Request): Promise<Response> => {
  try {
    const annotateLabel = process.env["OMNIVORE_ANNOTATE_LABEL"] ?? "do";

    const body: WebhookPayload = (await req.json()) as WebhookPayload;
    console.log("Received webhook payload:", body);

    // Check if it's a 'do:' action
    if (!body.action.startsWith("do")) {
      return new Response("Not a 'do:' action, ignoring.", { status: 200 });
    }

    const articleId = body.label?.pageId || body.page?.id;
    if (!articleId) {
      throw new Error("No article ID found in the webhook payload.");
    }

    // Transform 'do:' to 'did:'
    const didAction = body.action.replace("do:", "did:");

    // STEP 1: fetch the full article content and existing labels from Omnivore
    const omnivoreHeaders = {
      "Content-Type": "application/json",
      Authorization: process.env["OMNIVORE_API_KEY"] ?? "",
    };

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

    const promptFromLabel = articleLabels.find(
      ({ name }) => name.split(":")[0] === annotateLabel
    )?.description;

    const promptFromLabelWithFallback =
      promptFromLabel ||
      process.env["OPENAI_PROMPT"] ||
      "Return a tweet-length TL;DR of the following article.";

    const existingNote = highlights.find(({ type }) => type === "NOTE");

    const promptBodyArray = [
      promptFromLabelWithFallback,
      `Article title: ${articleTitle}`,
      `Article content: ${articleContent}`,
      existingNote ? `Existing note: ${existingNote}` : "",
    ];

    const model = process.env["OPENAI_MODEL"] || "gpt-4-turbo-preview";
    const settings = process.env["OPENAI_SETTINGS"] || `{"model":"${model}"}`;

    const openai = new OpenAI();
    // Handle different 'do:' actions
    if (body.action === "do:tags") {
      // STEP 2: generate new tags using OpenAI's API

      const articleLabelsPrompt = labelsToPrompt(
        articleLabels,
        annotateLabel,
        "Existing article tags: "
      );

      const allLabels = await getAllLabelsFromOmnivore(omnivoreHeaders);
      const allLabelsPrompt = labelsToPrompt(
        allLabels,
        annotateLabel,
        "All labels in Omnivore: "
      );

      const doTagsPrompt = `Generate a list of useful tags that could be added to this article. Only provide the list of tags, one per line. `;
      const prompt = arrayToPromptGenerator([
        doTagsPrompt,
        ...promptBodyArray,
        articleLabelsPrompt,
        allLabelsPrompt,
      ]);

      const completionResponse = await openai.chat.completions.create({
        ...JSON.parse(settings),
        messages: [{ role: "user", content: prompt }],
      });

      const generatedTags = completionResponse.choices[0].message.content
        ?.trim()
        .split("\n")
        .map((tag) => tag.trim())
        .filter(
          (tag) =>
            tag && !articleLabels.some((existing) => existing.name === tag)
        );

      if (!generatedTags || generatedTags.length === 0) {
        console.log(
          "No new tags generated.",
          completionResponse.choices[0].message.content
        );
        return new Response(`No new tags generated.`, { status: 200 });
      }

      console.log(`Generated tags: ${generatedTags.join(", ")}`);

      const labels = [
        ...articleLabels.map((label) => label.name),
        ...generatedTags,
        didAction,
      ];

      await addLabelsToOmnivoreArticle(
        articleId,
        generatedTags,
        omnivoreHeaders
      );

      return new Response(
        `New tags added to the article and action updated to did: action.`,
        { status: 200 }
      );
    } else if (body.action.startsWith("do:")) {
      const prompt = arrayToPromptGenerator([...promptBodyArray]);

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
        articleId,
        generatedResponse,
        omnivoreHeaders,
        existingNote
      );
      return new Response(`Annotation applied to the article.`, {
        status: 200,
      });
    } else {
      return new Response(`Unhandled action: ${body.action}`, { status: 400 });
    }
  } catch (error) {
    return new Response(
      `Error processing Omnivore webhook: ${(error as Error).message}`,
      { status: 500 }
    );
  }
};

function arrayToPromptGenerator(array: (string | null)[]): string {
  return array
    .filter((item): item is string => item !== null && item.trim() !== "")
    .map((item) => `- ${item}`)
    .join("\n");
}

function labelsToPrompt(
  labels: Label[],
  annotateLabel: string,
  prePrompt: string
): string | null {
  if (labels.length === 0) {
    return null;
  }
  const labelsWithoutAnnotationLabel = labels.filter(
    (label) => label.name.split(":")[0] !== annotateLabel
  );
  const labelString = labelsWithoutAnnotationLabel
    .map((label) => label.name)
    .join(", ");
  const existingArticleTagsPrompt = `${prePrompt} ${labelString}`;
  return existingArticleTagsPrompt;
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
