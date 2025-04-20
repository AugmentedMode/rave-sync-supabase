// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

interface Stage {
  id?: string;
  name: string;
  event_id: number;
  description?: string;
}

// Create Supabase client
const supabaseClient = createClient(
  Deno.env.get("SUPABASE_URL") || '',
  Deno.env.get("SUPABASE_ANON_KEY") || ''
);

// Create Supabase admin client using the Service Role Key for admin operations
const supabaseAdminClient = createClient(
  Deno.env.get("SUPABASE_URL") || '',
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ''
);

// Get API key from environment variables
const API_KEY = Deno.env.get("x-api-key");

// Error responses
function unauthorizedResponse() {
  return new Response(
    JSON.stringify({ error: "Unauthorized" }),
    { status: 401, headers: { "Content-Type": "application/json" } }
  );
}

function badRequestResponse(message = "Bad request") {
  return new Response(
    JSON.stringify({ error: message }),
    { status: 400, headers: { "Content-Type": "application/json" } }
  );
}

function methodNotAllowedResponse() {
  return new Response(
    JSON.stringify({ error: "Method not allowed" }),
    { status: 405, headers: { "Content-Type": "application/json" } }
  );
}

function serverErrorResponse(message = "Internal server error") {
  return new Response(
    JSON.stringify({ error: message }),
    { status: 500, headers: { "Content-Type": "application/json" } }
  );
}

// Verify API key for admin operations
function verifyApiKey(req: Request): boolean {
  const apiKeyHeader = req.headers.get("x-api-key");
  return apiKeyHeader === API_KEY;
}

// Get authenticated user from token
async function getAuthenticatedUser(req: Request) {
  const authHeader = req.headers.get("Authorization");
  const token = authHeader?.replace("Bearer ", "");
  if (!token) return null;
  
  try {
    const { data, error } = await supabaseClient.auth.getUser(token);
    if (error || !data.user) return null;
    
    return data.user;
  } catch (error) {
    console.error("Error authenticating user:", error);
    return null;
  }
}

// Extract eventId from URL for /events/:eventId/stages
function getEventIdFromUrl(url: URL): string | null {
  const pathParts = url.pathname.split('/');
  // Look for "events" followed by an ID followed by "stages" anywhere in the path
  for (let i = 0; i < pathParts.length - 2; i++) {
    if (pathParts[i] === "events" && pathParts[i + 2] === "stages") {
      return pathParts[i + 1];
    }
  }
  return null;
}

// Extract stageId from URL for /stages/:stageId
function getStageIdFromUrl(url: URL): string | null {
  const pathParts = url.pathname.split('/');
  // Look for "stages" followed by an ID anywhere in the path
  for (let i = 0; i < pathParts.length - 1; i++) {
    if (pathParts[i] === "stages" && i + 1 < pathParts.length && pathParts[i + 1] !== "events") {
      return pathParts[i + 1];
    }
  }
  return null;
}

// Handler for POST /events/:eventId/stages (createStage)
async function handleCreateStage(req: Request) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return unauthorizedResponse();
    }

    const url = new URL(req.url);
    const eventId = getEventIdFromUrl(url);
    
    if (!eventId) {
      return badRequestResponse("Missing event ID");
    }

    const { name, description } = await req.json() as Partial<Stage>;
    
    if (!name) {
      return badRequestResponse("Name is required");
    }

    // Verify that the event exists and user has access to it
    const { data: event, error: eventError } = await supabaseClient
      .from("events")
      .select("id")
      .eq("id", eventId)
      .single();

    if (eventError || !event) {
      return new Response(
        JSON.stringify({ error: "Event not found or access denied" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // Insert stage
    const { data, error } = await supabaseClient
      .from("stages")
      .insert([{
        name,
        event_id: Number(eventId),
        description
      }])
      .select()
      .single();

    if (error) {
      console.error("Error creating stage:", error);
      return serverErrorResponse(error.message);
    }

    return new Response(
      JSON.stringify({ success: true, stage: data }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Unexpected error in createStage:", error);
    return serverErrorResponse(error.message);
  }
}

// Handler for GET /events/:eventId/stages (listStages)
async function handleListStages(req: Request) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return unauthorizedResponse();
    }

    const url = new URL(req.url);
    const eventId = getEventIdFromUrl(url);
    
    if (!eventId) {
      return badRequestResponse("Missing event ID");
    }

    // Verify that the event exists and user has access to it
    const { data: event, error: eventError } = await supabaseClient
      .from("events")
      .select("id")
      .eq("id", eventId)
      .single();

    if (eventError || !event) {
      return new Response(
        JSON.stringify({ error: "Event not found or access denied" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // Get stages for the event
    const { data: stages, error } = await supabaseClient
      .from("stages")
      .select("*")
      .eq("event_id", eventId)
      .order("name");

    if (error) {
      console.error("Error fetching stages:", error);
      return serverErrorResponse(error.message);
    }

    return new Response(
      JSON.stringify(stages),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Unexpected error in listStages:", error);
    return serverErrorResponse(error.message);
  }
}

// Handler for PUT /stages/:stageId (updateStage)
async function handleUpdateStage(req: Request) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return unauthorizedResponse();
    }

    console.log("handleUpdateStage");
    console.log(req);

    const url = new URL(req.url);
    const stageId = getStageIdFromUrl(url);
    
    if (!stageId) {
      return badRequestResponse("Missing stage ID");
    }

    const updates = await req.json() as Partial<Stage>;
    
    // Remove id from updates if present
    if (updates.id) {
      delete updates.id;
    }

    // Remove event_id from updates if present
    if (updates.event_id) {
      delete updates.event_id;
    }

    console.log("updates");
    console.log('stageId', stageId);

    // Verify that the stage exists
    const { data: stage, error: stageError } = await supabaseClient
      .from("stages")
      .select("id, event_id")
      .eq("id", stageId)
      .single();

    if (stageError || !stage) {
      return new Response(
        JSON.stringify({ error: "Stage not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // Verify user has access to the associated event
    const { data: event, error: eventError } = await supabaseClient
      .from("events")
      .select("id")
      .eq("id", stage.event_id)
      .single();

    if (eventError || !event) {
      return unauthorizedResponse();
    }

    // Update stage
    const { data, error } = await supabaseClient
      .from("stages")
      .update(updates)
      .eq("id", stageId)
      .select()
      .single();

    if (error) {
      console.error("Error updating stage:", error);
      return serverErrorResponse(error.message);
    }

    return new Response(
      JSON.stringify({ success: true, stage: data }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Unexpected error in updateStage:", error);
    return serverErrorResponse(error.message);
  }
}

// Handler for DELETE /stages/:stageId (deleteStage)
async function handleDeleteStage(req: Request) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return unauthorizedResponse();
    }

    const url = new URL(req.url);
    const stageId = getStageIdFromUrl(url);
    
    if (!stageId) {
      return badRequestResponse("Missing stage ID");
    }

    // Verify that the stage exists
    const { data: stage, error: stageError } = await supabaseClient
      .from("stages")
      .select("id, event_id")
      .eq("id", stageId)
      .single();

    if (stageError || !stage) {
      return new Response(
        JSON.stringify({ error: "Stage not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // Verify user has access to the associated event
    const { data: event, error: eventError } = await supabaseClient
      .from("events")
      .select("id")
      .eq("id", stage.event_id)
      .single();

    if (eventError || !event) {
      return unauthorizedResponse();
    }

    // Delete stage
    const { error } = await supabaseClient
      .from("stages")
      .delete()
      .eq("id", stageId);

    if (error) {
      console.error("Error deleting stage:", error);
      return serverErrorResponse(error.message);
    }

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Unexpected error in deleteStage:", error);
    return serverErrorResponse(error.message);
  }
}

// Main handler
Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    const method = req.method;
    const path = url.pathname;
    
    console.log(`${method} ${path}`);
    
    // Extract eventId and stageId directly from the URL
    const eventId = getEventIdFromUrl(url);
    const stageId = getStageIdFromUrl(url);
    
    console.log(`Detected eventId: ${eventId}, stageId: ${stageId}`);

    // Determine if this is an event-stage route or a stage-specific route
    const isEventStagesRoute = path.includes("/events/") && path.includes("/stages");
    const isStageRoute = path.includes("/stages/") && !path.includes("/events/");
    
    console.log(`isEventStagesRoute: ${isEventStagesRoute}, isStageRoute: ${isStageRoute}`);

    // Route requests to appropriate handlers
    if (eventId) {
      if (method === "POST") {
        return await handleCreateStage(req);
      } else if (method === "GET") {
        return await handleListStages(req);
      }
    } else if (stageId) {
      if (method === "PUT") {
        return await handleUpdateStage(req);
      } else if (method === "DELETE") {
        return await handleDeleteStage(req);
      }
    }

    return methodNotAllowedResponse();
  } catch (error) {
    console.error("Unexpected error in main handler:", error);
    return serverErrorResponse("Internal server error");
  }
})

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make HTTP requests to test the endpoints:

  # Create Stage (Authenticated)
  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/stages/events/EVENT_ID/stages' \
    --header 'Authorization: Bearer YOUR_AUTH_TOKEN' \
    --header 'Content-Type: application/json' \
    --data '{"name":"Main Stage","description":"The primary stage for headliners"}'

  # List Stages for an Event (Authenticated)
  curl -i --location --request GET 'http://127.0.0.1:54321/functions/v1/stages/events/EVENT_ID/stages' \
    --header 'Authorization: Bearer YOUR_AUTH_TOKEN'

  # Update Stage (Authenticated)
  curl -i --location --request PUT 'http://127.0.0.1:54321/functions/v1/stages/stages/STAGE_ID' \
    --header 'Authorization: Bearer YOUR_AUTH_TOKEN' \
    --header 'Content-Type: application/json' \
    --data '{"name":"Updated Stage Name","description":"Updated description"}'

  # Delete Stage (Authenticated)
  curl -i --location --request DELETE 'http://127.0.0.1:54321/functions/v1/stages/stages/STAGE_ID' \
    --header 'Authorization: Bearer YOUR_AUTH_TOKEN'
*/
