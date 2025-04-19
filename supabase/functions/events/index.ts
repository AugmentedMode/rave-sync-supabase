// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

interface Event {
  id?: string;
  name: string;
  date_start: string;
  date_end: string;
  venue?: string;
  city?: string;
  country?: string;
  featured?: boolean;
  details?: string;
  image_url?: string;
  created_by?: string | null;
}

// Create Supabase client
const supabaseClient = createClient(
  Deno.env.get("SUPABASE_URL") || '',
  Deno.env.get("SUPABASE_ANON_KEY") || ''
);

// Create Supabase admin client using the Service Role Key for admin operations
const supabaseAdminClient = createClient(
  Deno.env.get("SUPABASE_URL") || '',
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || '' // Use the Service Role Key here
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

// Parse URL to get event ID if present
function getEventIdFromUrl(url: URL): string | null {
  const pathParts = url.pathname.split('/');
  // Expected format: /events/:id
  if (pathParts.length >= 3) {
    return pathParts[2];
  }
  return null;
}

// Handler for POST /events (createEvent)
async function handleCreateEvent(req: Request) {
  // Verify API key for admin operations
  if (!verifyApiKey(req)) {
    return unauthorizedResponse();
  }

  try {
    const body = await req.json() as Event;
    const { name, date_start, date_end, venue, city, country, featured, details, image_url } = body;

    // Validate required fields
    if (!name || !date_start || !date_end) {
      return badRequestResponse("Missing required fields: name, date_start, date_end");
    }

    // Insert event using the admin client
    const { data, error } = await supabaseAdminClient
      .from("events")
      .insert([{
        name,
        date_start,
        date_end,
        venue,
        city,
        country,
        featured,
        details,
        image_url,
        created_by: null // Could be set to admin ID if available
      }])
      .select()
      .single();

    if (error) {
      console.error("Error creating event:", error);
      return serverErrorResponse(error.message);
    }

    return new Response(
      JSON.stringify({ success: true, event: data }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Unexpected error in createEvent:", error);
    return serverErrorResponse(error.message);
  }
}

// Handler for GET /events (listEvents)
async function handleListEvents(req: Request) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return unauthorizedResponse();
    }

    const url = new URL(req.url);
    
    // Parse query parameters
    const featured = url.searchParams.get('featured') === 'true';
    const search = url.searchParams.get('search');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const page = parseInt(url.searchParams.get('page') || '1');
    const pageSize = parseInt(url.searchParams.get('pageSize') || '10');
    
    // Calculate pagination
    const startRange = (page - 1) * pageSize;
    const endRange = page * pageSize - 1;

    // Start building query
    let query = supabaseClient
      .from("events")
      .select("id, name, date_start, date_end, venue, city, country, featured, details, image_url");
      
    // Add range after all filters are applied
    
    // Apply filters
    if (featured) {
      query = query.eq('featured', true);
    }
    
    if (search) {
      query = query.ilike('name', `%${search}%`);
    }
    
    if (from) {
      query = query.gte('date_start', from);
    }
    
    if (to) {
      query = query.lte('date_end', to);
    }
    
    // Add pagination
    query = query.range(startRange, endRange);

    const { data: events, error } = await query;

    if (error) {
      console.error("Error fetching events:", error);
      return serverErrorResponse(error.message);
    }

    // Get user events for the authenticated user
    const { data: userEvents, error: userEventError } = await supabaseClient
      .from("user_events")
      .select("event_id")
      .eq("user_id", user.id);
      
    if (userEventError) {
      console.error("Error fetching user events:", userEventError);
      // Continue with empty user events rather than failing
    }

    // Create map of user events
    const userEventMap = Object.fromEntries(
      (userEvents || []).map(ue => [ue.event_id, true])
    );

    // Enrich events with user_event flag
    const enrichedEvents = events.map(event => ({
      ...event,
      has_user_event: userEventMap[event.id] || false
    }));

    return new Response(
      JSON.stringify(enrichedEvents),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Unexpected error in listEvents:", error);
    return serverErrorResponse(error.message);
  }
}

// Handler for GET /events/:id (getEvent)
async function handleGetEvent(req: Request) {
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

    const { data: event, error } = await supabaseClient
      .from("events")
      .select("*")
      .eq("id", eventId)
      .single();

    if (error) {
      console.error("Error fetching event:", error);
      return serverErrorResponse(error.message);
    }

    if (!event) {
      return new Response(
        JSON.stringify({ error: "Event not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // Check if user has saved this event
    const { data: userEvent, error: userEventError } = await supabaseClient
      .from("user_events")
      .select("*")
      .eq("event_id", eventId)
      .eq("user_id", user.id)
      .maybeSingle();
      
    if (userEventError) {
      console.error("Error fetching user event:", userEventError);
      // Continue with empty user event rather than failing
    }

    const enrichedEvent = {
      ...event,
      has_user_event: !!userEvent
    };

    return new Response(
      JSON.stringify(enrichedEvent),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Unexpected error in getEvent:", error);
    return serverErrorResponse(error.message);
  }
}

// Handler for PUT /events/:id (updateEvent)
async function handleUpdateEvent(req: Request) {
  // Verify API key for admin operations
  if (!verifyApiKey(req)) {
    return unauthorizedResponse();
  }

  try {
    const url = new URL(req.url);
    const eventId = getEventIdFromUrl(url);
    
    if (!eventId) {
      return badRequestResponse("Missing event ID");
    }

    const updates = await req.json() as Partial<Event>;
    
    // Remove id from updates if present
    if (updates.id) {
      delete updates.id;
    }

    // Prevent updating created_by field
    if (updates.created_by) {
      delete updates.created_by;
    }

    // Use the admin client for the update operation
    const { data, error } = await supabaseAdminClient
      .from("events")
      .update(updates)
      .eq("id", eventId)
      .select()
      .single();

    if (error) {
      console.error("Error updating event:", error);
      return serverErrorResponse(error.message);
    }

    return new Response(
      JSON.stringify({ success: true, event: data }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Unexpected error in updateEvent:", error);
    return serverErrorResponse(error.message);
  }
}

// Handler for DELETE /events/:id (deleteEvent)
async function handleDeleteEvent(req: Request) {
  // Verify API key for admin operations
  if (!verifyApiKey(req)) {
    return unauthorizedResponse();
  }

  try {
    const url = new URL(req.url);
    const eventId = getEventIdFromUrl(url);
    
    if (!eventId) {
      return badRequestResponse("Missing event ID");
    }

    // Use the admin client for the delete operation
    const { error } = await supabaseAdminClient
      .from("events")
      .delete()
      .eq("id", eventId);

    if (error) {
      console.error("Error deleting event:", error);
      return serverErrorResponse(error.message);
    }

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Unexpected error in deleteEvent:", error);
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
    
    // Handle base path for convenience (/functions/v1/events vs /events)
    const normalizedPath = path.replace(/^\/functions\/v1/, '');
    const eventId = getEventIdFromUrl(new URL(`http://localhost${normalizedPath}`));

    // Route requests to appropriate handlers
    if (normalizedPath === "/events" || normalizedPath === "/events/") {
      if (method === "POST") {
        return await handleCreateEvent(req);
      } else if (method === "GET") {
        return await handleListEvents(req);
      }
    } else if (normalizedPath.startsWith("/events/") && eventId) {
      if (method === "GET") {
        return await handleGetEvent(req);
      } else if (method === "PUT") {
        return await handleUpdateEvent(req);
      } else if (method === "DELETE") {
        return await handleDeleteEvent(req);
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

  # Create Event (Admin)
  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/events' \
    --header 'x-api-key: YOUR_API_KEY' \
    --header 'Content-Type: application/json' \
    --data '{"name":"Summer Festival 2023","date_start":"2023-07-01","date_end":"2023-07-03","venue":"Central Park","city":"New York","country":"USA","featured":true}'

  # List Events (Authenticated)
  curl -i --location --request GET 'http://127.0.0.1:54321/functions/v1/events' \
    --header 'Authorization: Bearer YOUR_AUTH_TOKEN'

  # Get Event (Authenticated)
  curl -i --location --request GET 'http://127.0.0.1:54321/functions/v1/events/EVENT_ID' \
    --header 'Authorization: Bearer YOUR_AUTH_TOKEN'

  # Update Event (Admin)
  curl -i --location --request PUT 'http://127.0.0.1:54321/functions/v1/events/EVENT_ID' \
    --header 'x-api-key: YOUR_API_KEY' \
    --header 'Content-Type: application/json' \
    --data '{"featured":false}'

  # Delete Event (Admin)
  curl -i --location --request DELETE 'http://127.0.0.1:54321/functions/v1/events/EVENT_ID' \
    --header 'x-api-key: YOUR_API_KEY'
*/
