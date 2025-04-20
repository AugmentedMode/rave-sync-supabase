// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

interface SetTime {
  id?: number;
  artist_id: number;
  stage_id: number;
  start_time: string;
  end_time: string;
  notes?: string;
}

interface Collaboration {
  id?: number;
  set_time_id: number;
  artist_id: number;
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

// Extract eventId from URL for /events/:eventId/schedule or /set-times/:eventId/schedule
function getEventIdFromUrl(url: URL): string | null {
  const pathParts = url.pathname.split('/');
  
  // Look for "events" followed by an ID followed by "schedule" anywhere in the path
  for (let i = 0; i < pathParts.length - 2; i++) {
    if ((pathParts[i] === "events" || pathParts[i] === "set-times") && pathParts[i + 2] === "schedule") {
      return pathParts[i + 1];
    }
  }
  return null;
}

// Extract setTimeId from URL for /set_times/:setTimeId
function getSetTimeIdFromUrl(url: URL): string | null {
  const pathParts = url.pathname.split('/');
  // Look for "set_times" or "set-times" followed by an ID anywhere in the path
  for (let i = 0; i < pathParts.length - 1; i++) {
    if ((pathParts[i] === "set_times" || pathParts[i] === "set-times") && i + 1 < pathParts.length) {
      return pathParts[i + 1];
    }
  }
  return null;
}

// Extract collaborationId from URL for /artist_collaborations/:collabId
function getCollaborationIdFromUrl(url: URL): string | null {
  const pathParts = url.pathname.split('/');
  // Look for "artist_collaborations" followed by an ID anywhere in the path
  for (let i = 0; i < pathParts.length - 1; i++) {
    if (pathParts[i] === "artist_collaborations" && i + 1 < pathParts.length) {
      return pathParts[i + 1];
    }
  }
  return null;
}

// Handler for POST /set_times (createSetTime)
async function handleCreateSetTime(req: Request) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return unauthorizedResponse();
    }

    const body = await req.json() as SetTime;
    const { artist_id, stage_id, start_time, end_time, notes } = body;

    // Validate required fields
    if (!artist_id || !stage_id || !start_time || !end_time) {
      return badRequestResponse("Missing required fields: artist_id, stage_id, start_time, end_time");
    }

    // Verify that the artist exists
    const { data: artist, error: artistError } = await supabaseClient
      .from("artists")
      .select("id")
      .eq("id", artist_id)
      .single();

    if (artistError || !artist) {
      return new Response(
        JSON.stringify({ error: "Artist not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // Verify that the stage exists
    const { data: stage, error: stageError } = await supabaseClient
      .from("stages")
      .select("id, event_id")
      .eq("id", stage_id)
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

    // Insert set time
    const { data, error } = await supabaseClient
      .from("set_times")
      .insert([{
        artist_id,
        stage_id,
        start_time,
        end_time,
        notes
      }])
      .select()
      .single();

    if (error) {
      console.error("Error creating set time:", error);
      return serverErrorResponse(error.message);
    }

    return new Response(
      JSON.stringify({ success: true, set_time: data }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Unexpected error in createSetTime:", error);
    return serverErrorResponse(error.message);
  }
}

// Handler for GET /events/:eventId/schedule (listSetTimes)
async function handleListSetTimes(req: Request) {
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

    // Get all stages for this event
    const { data: stages, error: stagesError } = await supabaseClient
      .from("stages")
      .select("id, name, description")
      .eq("event_id", eventId);

    if (stagesError) {
      console.error("Error fetching stages:", stagesError);
      return serverErrorResponse(stagesError.message);
    }

    // Create a map of stage IDs to stage info
    const stageMap = Object.fromEntries(
      (stages || []).map(stage => [stage.id, stage])
    );
    
    // Get all stage IDs for the query
    const stageIds = stages.map(stage => stage.id);
    
    // If there are no stages, return empty schedule
    if (stageIds.length === 0) {
      return new Response(
        JSON.stringify([]),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // Get set times for all stages in this event
    const { data: setTimes, error: setTimesError } = await supabaseClient
      .from("set_times")
      .select(`
        id,
        start_time,
        end_time,
        notes,
        stage_id,
        artist:artist_id (
          id,
          name,
          image_url
        )
      `)
      .in("stage_id", stageIds)
      .order("start_time", { ascending: true });

    if (setTimesError) {
      console.error("Error fetching set times:", setTimesError);
      return serverErrorResponse(setTimesError.message);
    }

    // Get all set time IDs
    const setTimeIds = setTimes.map(setTime => setTime.id);

    // Get collaborations for all set times
    const { data: collaborations, error: collabError } = await supabaseClient
      .from("artist_collaborations")
      .select(`
        id,
        set_time_id,
        artist:artist_id (
          id,
          name,
          image_url
        )
      `)
      .in("set_time_id", setTimeIds);

    if (collabError) {
      console.error("Error fetching collaborations:", collabError);
      // Continue without collaborations rather than failing
    }

    // Create a map of set time IDs to collaborations
    const collaborationMap = {};
    (collaborations || []).forEach(collab => {
      if (!collaborationMap[collab.set_time_id]) {
        collaborationMap[collab.set_time_id] = [];
      }
      collaborationMap[collab.set_time_id].push(collab.artist);
    });

    // Enrich set times with collaborations
    const enrichedSetTimes = setTimes.map(setTime => ({
      ...setTime,
      stage: stageMap[setTime.stage_id],
      collaborators: collaborationMap[setTime.id] || []
    }));

    // Group by stage
    const schedule = stages.map(stage => ({
      stage,
      set_times: enrichedSetTimes.filter(st => st.stage_id === stage.id)
    }));

    return new Response(
      JSON.stringify(schedule),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Unexpected error in listSetTimes:", error);
    return serverErrorResponse(error.message);
  }
}

// Handler for PUT /set_times/:setTimeId (updateSetTime)
async function handleUpdateSetTime(req: Request) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return unauthorizedResponse();
    }

    const url = new URL(req.url);
    const setTimeId = getSetTimeIdFromUrl(url);
    
    if (!setTimeId) {
      return badRequestResponse("Missing set time ID");
    }

    const updates = await req.json() as Partial<SetTime>;
    
    // Remove id from updates if present
    if (updates.id) {
      delete updates.id;
    }

    // Verify that the set time exists
    const { data: setTime, error: setTimeError } = await supabaseClient
      .from("set_times")
      .select("id, stage_id")
      .eq("id", setTimeId)
      .single();

    if (setTimeError || !setTime) {
      return new Response(
        JSON.stringify({ error: "Set time not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // If stage_id is being updated, verify the new stage exists
    if (updates.stage_id && updates.stage_id !== setTime.stage_id) {
      const { data: stage, error: stageError } = await supabaseClient
        .from("stages")
        .select("id, event_id")
        .eq("id", updates.stage_id)
        .single();

      if (stageError || !stage) {
        return new Response(
          JSON.stringify({ error: "New stage not found" }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // Get the event ID through the stage
    const { data: stage, error: stageError } = await supabaseClient
      .from("stages")
      .select("event_id")
      .eq("id", setTime.stage_id)
      .single();

    if (stageError || !stage) {
      return serverErrorResponse("Error retrieving stage information");
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

    // Update set time
    const { data, error } = await supabaseClient
      .from("set_times")
      .update(updates)
      .eq("id", setTimeId)
      .select()
      .single();

    if (error) {
      console.error("Error updating set time:", error);
      return serverErrorResponse(error.message);
    }

    return new Response(
      JSON.stringify({ success: true, set_time: data }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Unexpected error in updateSetTime:", error);
    return serverErrorResponse(error.message);
  }
}

// Handler for DELETE /set_times/:setTimeId (deleteSetTime)
async function handleDeleteSetTime(req: Request) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return unauthorizedResponse();
    }

    const url = new URL(req.url);
    const setTimeId = getSetTimeIdFromUrl(url);
    
    if (!setTimeId) {
      return badRequestResponse("Missing set time ID");
    }

    // Verify that the set time exists
    const { data: setTime, error: setTimeError } = await supabaseClient
      .from("set_times")
      .select("id, stage_id")
      .eq("id", setTimeId)
      .single();

    if (setTimeError || !setTime) {
      return new Response(
        JSON.stringify({ error: "Set time not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // Get the event ID through the stage
    const { data: stage, error: stageError } = await supabaseClient
      .from("stages")
      .select("event_id")
      .eq("id", setTime.stage_id)
      .single();

    if (stageError || !stage) {
      return serverErrorResponse("Error retrieving stage information");
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

    // Delete set time
    const { error } = await supabaseClient
      .from("set_times")
      .delete()
      .eq("id", setTimeId);

    if (error) {
      console.error("Error deleting set time:", error);
      return serverErrorResponse(error.message);
    }

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Unexpected error in deleteSetTime:", error);
    return serverErrorResponse(error.message);
  }
}

// Handler for POST /set_times/:setTimeId/collaborations (addCollaboration)
async function handleAddCollaboration(req: Request) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return unauthorizedResponse();
    }

    const url = new URL(req.url);
    const setTimeId = getSetTimeIdFromUrl(url);
    
    if (!setTimeId) {
      return badRequestResponse("Missing set time ID");
    }

    const body = await req.json();
    const { artist_id } = body;

    if (!artist_id) {
      return badRequestResponse("Missing required field: artist_id");
    }

    // Verify that the set time exists
    const { data: setTime, error: setTimeError } = await supabaseClient
      .from("set_times")
      .select("id, stage_id, artist_id")
      .eq("id", setTimeId)
      .single();

    if (setTimeError || !setTime) {
      return new Response(
        JSON.stringify({ error: "Set time not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // Don't allow adding the main artist as a collaborator
    if (setTime.artist_id === artist_id) {
      return badRequestResponse("Cannot add main artist as a collaborator");
    }

    // Verify that the artist exists
    const { data: artist, error: artistError } = await supabaseClient
      .from("artists")
      .select("id")
      .eq("id", artist_id)
      .single();

    if (artistError || !artist) {
      return new Response(
        JSON.stringify({ error: "Artist not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // Get the event ID through the stage
    const { data: stage, error: stageError } = await supabaseClient
      .from("stages")
      .select("event_id")
      .eq("id", setTime.stage_id)
      .single();

    if (stageError || !stage) {
      return serverErrorResponse("Error retrieving stage information");
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

    // Insert collaboration
    const { data, error } = await supabaseClient
      .from("artist_collaborations")
      .insert([{
        set_time_id: parseInt(setTimeId),
        artist_id
      }])
      .select()
      .single();

    if (error) {
      // Check if it's a unique constraint violation
      if (error.code === '23505') {
        return new Response(
          JSON.stringify({ error: "This artist is already a collaborator for this set time" }),
          { status: 409, headers: { "Content-Type": "application/json" } }
        );
      }
      
      console.error("Error adding collaboration:", error);
      return serverErrorResponse(error.message);
    }

    return new Response(
      JSON.stringify({ success: true, collaboration: data }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Unexpected error in addCollaboration:", error);
    return serverErrorResponse(error.message);
  }
}

// Handler for GET /set_times/:setTimeId/collaborations (listCollaborations)
async function handleListCollaborations(req: Request) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return unauthorizedResponse();
    }

    const url = new URL(req.url);
    const setTimeId = getSetTimeIdFromUrl(url);
    
    if (!setTimeId) {
      return badRequestResponse("Missing set time ID");
    }

    // Verify that the set time exists
    const { data: setTime, error: setTimeError } = await supabaseClient
      .from("set_times")
      .select("id, stage_id")
      .eq("id", setTimeId)
      .single();

    if (setTimeError || !setTime) {
      return new Response(
        JSON.stringify({ error: "Set time not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // Get the event ID through the stage
    const { data: stage, error: stageError } = await supabaseClient
      .from("stages")
      .select("event_id")
      .eq("id", setTime.stage_id)
      .single();

    if (stageError || !stage) {
      return serverErrorResponse("Error retrieving stage information");
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

    // Get collaborations with artist details
    const { data, error } = await supabaseClient
      .from("artist_collaborations")
      .select(`
        id,
        set_time_id,
        artist:artist_id (
          id,
          name,
          spotify_id,
          image_url
        )
      `)
      .eq("set_time_id", setTimeId);

    if (error) {
      console.error("Error fetching collaborations:", error);
      return serverErrorResponse(error.message);
    }

    return new Response(
      JSON.stringify(data),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Unexpected error in listCollaborations:", error);
    return serverErrorResponse(error.message);
  }
}

// Handler for DELETE /artist_collaborations/:collabId (removeCollaboration)
async function handleRemoveCollaboration(req: Request) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return unauthorizedResponse();
    }

    const url = new URL(req.url);
    const collabId = getCollaborationIdFromUrl(url);
    
    if (!collabId) {
      return badRequestResponse("Missing collaboration ID");
    }

    // Verify that the collaboration exists
    const { data: collab, error: collabError } = await supabaseClient
      .from("artist_collaborations")
      .select("id, set_time_id")
      .eq("id", collabId)
      .single();

    if (collabError || !collab) {
      return new Response(
        JSON.stringify({ error: "Collaboration not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // Get set time to verify access
    const { data: setTime, error: setTimeError } = await supabaseClient
      .from("set_times")
      .select("stage_id")
      .eq("id", collab.set_time_id)
      .single();

    if (setTimeError || !setTime) {
      return new Response(
        JSON.stringify({ error: "Associated set time not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // Get the event ID through the stage
    const { data: stage, error: stageError } = await supabaseClient
      .from("stages")
      .select("event_id")
      .eq("id", setTime.stage_id)
      .single();

    if (stageError || !stage) {
      return serverErrorResponse("Error retrieving stage information");
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

    // Delete collaboration
    const { error } = await supabaseClient
      .from("artist_collaborations")
      .delete()
      .eq("id", collabId);

    if (error) {
      console.error("Error removing collaboration:", error);
      return serverErrorResponse(error.message);
    }

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Unexpected error in removeCollaboration:", error);
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

    // Extract IDs from the URL
    const eventId = getEventIdFromUrl(url);
    const setTimeId = getSetTimeIdFromUrl(url);
    const collabId = getCollaborationIdFromUrl(url);
    
    console.log('eventId', eventId);
    console.log('setTimeId', setTimeId);
    console.log('collabId', collabId);
    
    // Check URL patterns
    const isScheduleRoute = path.includes("/schedule") && eventId;
    const isSetTimesPostRoute = (path === "/set_times" || path === "/set_times/" || path === "/set-times" || path === "/set-times/");
    const isSetTimeRoute = (path.includes("/set_times/") || path.includes("/set-times/")) && setTimeId && !path.includes("/collaborations") && !path.includes("/schedule");
    const isCollaborationsPostRoute = path.includes("/collaborations") && setTimeId && !path.includes("artist_collaborations");
    const isCollaborationsGetRoute = path.includes("/collaborations") && setTimeId && !path.includes("artist_collaborations");
    const isArtistCollaborationsRoute = path.includes("/artist_collaborations/") && collabId;
    
    console.log('isScheduleRoute', isScheduleRoute);
    console.log('isSetTimesPostRoute', isSetTimesPostRoute);
    console.log('isSetTimeRoute', isSetTimeRoute);
    console.log('isCollaborationsPostRoute', isCollaborationsPostRoute);
    console.log('isCollaborationsGetRoute', isCollaborationsGetRoute);
    console.log('isArtistCollaborationsRoute', isArtistCollaborationsRoute);

    console.log('method', method);
    console.log('path', path);
    
    // Route requests to appropriate handlers
    if (isSetTimesPostRoute && method === "POST") {
      return await handleCreateSetTime(req);
    } else if (isScheduleRoute && method === "GET") {
      return await handleListSetTimes(req);
    } else if (isSetTimeRoute && method === "PUT") {
      return await handleUpdateSetTime(req);
    } else if (isSetTimeRoute && method === "DELETE") {
      return await handleDeleteSetTime(req);
    } else if (isCollaborationsPostRoute && method === "POST") {
      return await handleAddCollaboration(req);
    } else if (isCollaborationsGetRoute && method === "GET") {
      return await handleListCollaborations(req);
    } else if (isArtistCollaborationsRoute && method === "DELETE") {
      return await handleRemoveCollaboration(req);
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

  # Create Set Time (Authenticated)
  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/set_times' \
    --header 'Authorization: Bearer YOUR_AUTH_TOKEN' \
    --header 'Content-Type: application/json' \
    --data '{"artist_id":1,"stage_id":1,"start_time":"2023-07-01T18:00:00Z","end_time":"2023-07-01T19:30:00Z","notes":"Opening set"}'

  # List Set Times for an Event (Authenticated) - both URL formats work
  curl -i --location --request GET 'http://127.0.0.1:54321/functions/v1/events/1/schedule' \
    --header 'Authorization: Bearer YOUR_AUTH_TOKEN'
    
  # Alternative URL format for schedule
  curl -i --location --request GET 'http://127.0.0.1:54321/functions/v1/set-times/1/schedule' \
    --header 'Authorization: Bearer YOUR_AUTH_TOKEN'

  # Update Set Time (Authenticated)
  curl -i --location --request PUT 'http://127.0.0.1:54321/functions/v1/set_times/1' \
    --header 'Authorization: Bearer YOUR_AUTH_TOKEN' \
    --header 'Content-Type: application/json' \
    --data '{"start_time":"2023-07-01T18:30:00Z","end_time":"2023-07-01T20:00:00Z"}'

  # Delete Set Time (Authenticated)
  curl -i --location --request DELETE 'http://127.0.0.1:54321/functions/v1/set_times/1' \
    --header 'Authorization: Bearer YOUR_AUTH_TOKEN'

  # Add Collaboration (Authenticated)
  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/set_times/1/collaborations' \
    --header 'Authorization: Bearer YOUR_AUTH_TOKEN' \
    --header 'Content-Type: application/json' \
    --data '{"artist_id":2}'

  # List Collaborations (Authenticated)
  curl -i --location --request GET 'http://127.0.0.1:54321/functions/v1/set_times/1/collaborations' \
    --header 'Authorization: Bearer YOUR_AUTH_TOKEN'

  # Remove Collaboration (Authenticated)
  curl -i --location --request DELETE 'http://127.0.0.1:54321/functions/v1/artist_collaborations/1' \
    --header 'Authorization: Bearer YOUR_AUTH_TOKEN'
*/
