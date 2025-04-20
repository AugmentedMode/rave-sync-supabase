// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

interface GroupSchedule {
  id?: number;
  name: string;
  event_id: number;
  created_by: string;
  created_at?: string;
  updated_at?: string;
}

interface GroupMember {
  id?: number;
  group_id: number;
  user_id: string;
  is_admin: boolean;
  status: 'invited' | 'accepted' | 'declined';
  joined_at?: string;
  created_at?: string;
}

// Create Supabase admin client using the Service Role Key for admin operations
const supabaseAdminClient = createClient(
  Deno.env.get("SUPABASE_URL") || '',
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ''
);

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

function notFoundResponse(message = "Resource not found") {
  return new Response(
    JSON.stringify({ error: message }),
    { status: 404, headers: { "Content-Type": "application/json" } }
  );
}

// Get authenticated user from token
async function getAuthenticatedUser(req: Request) {
  const authHeader = req.headers.get("Authorization");
  const token = authHeader?.replace("Bearer ", "");
  if (!token) return { user: null, token: null };
  
  try {
    // Create a client with the user's token for this authentication check
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") || '',
      Deno.env.get("SUPABASE_ANON_KEY") || ''
    );
    
    const { data, error } = await supabaseClient.auth.getUser(token);
    if (error || !data.user) return { user: null, token: null };
    
    return { user: data.user, token };
  } catch (error) {
    console.error("Error authenticating user:", error);
    return { user: null, token: null };
  }
}

// Create a Supabase client with proper auth token
function createAuthClient(token: string) {
  return createClient(
    Deno.env.get("SUPABASE_URL") || '',
    Deno.env.get("SUPABASE_ANON_KEY") || '',
    {
      global: {
        headers: { Authorization: `Bearer ${token}` }
      }
    }
  );
}

// Extract group schedule ID from URL for /group-schedules/:id
function getGroupIdFromUrl(url: URL): string | null {
  const pathParts = url.pathname.split('/');
  
  // Look for "/group-schedules/:id" pattern
  for (let i = 0; i < pathParts.length - 1; i++) {
    if (pathParts[i] === "group-schedules" && i + 1 < pathParts.length) {
      const id = pathParts[i + 1];
      // Make sure it's a valid ID and not another route
      if (id && !isNaN(Number(id))) {
        return id;
      }
    }
  }
  return null;
}

// Handler for GET /group-schedules (listGroupSchedules)
async function handleListGroupSchedules(req: Request) {
  try {
    const { user, token } = await getAuthenticatedUser(req);
    if (!user) {
      return unauthorizedResponse();
    }

    const supabaseClient = createAuthClient(token!);
    const url = new URL(req.url);
    
    // Parse query parameters
    const eventId = url.searchParams.get('event_id');
    const page = parseInt(url.searchParams.get('page') || '1');
    const pageSize = parseInt(url.searchParams.get('pageSize') || '20');
    
    // Calculate pagination
    const startRange = (page - 1) * pageSize;
    const endRange = page * pageSize - 1;

    // Get groups created by the user
    const { data: createdGroups, error: createdError } = await supabaseClient
      .from("group_schedules")
      .select(`
        *,
        events:event_id (
          id,
          name,
          image_url
        ),
        members:group_members!group_id (
          id,
          user_id,
          is_admin,
          status
        )
      `)
      .eq("created_by", user.id)
      .order('created_at', { ascending: false });
      
    if (createdError) {
      console.error("Error fetching created groups:", createdError);
      return serverErrorResponse(createdError.message);
    }
    
    // Get groups where user is a member
    const { data: memberGroups, error: memberError } = await supabaseClient
      .from("group_members")
      .select(`
        group:group_id (
          *,
          events:event_id (
            id,
            name,
            image_url
          ),
          members:group_members!group_id (
            id,
            user_id,
            is_admin,
            status
          )
        )
      `)
      .eq("user_id", user.id)
      .order('created_at', { ascending: false });
      
    if (memberError) {
      console.error("Error fetching member groups:", memberError);
      return serverErrorResponse(memberError.message);
    }
    
    // Combine and filter results
    const allGroups = [
      ...createdGroups,
      ...memberGroups.map(item => item.group).filter(Boolean)
    ];
    
    // Remove duplicates (in case user is both creator and member)
    const uniqueGroups = Array.from(
      new Map(allGroups.map(group => [group.id, group])).values()
    );
    
    // Apply event filter if provided
    let filteredGroups = uniqueGroups;
    if (eventId) {
      filteredGroups = uniqueGroups.filter(group => group.event_id.toString() === eventId);
    }
    
    // Apply pagination
    const totalCount = filteredGroups.length;
    const paginatedGroups = filteredGroups.slice(startRange, endRange + 1);

    return new Response(
      JSON.stringify({
        group_schedules: paginatedGroups,
        pagination: {
          page,
          pageSize,
          totalCount,
          totalPages: Math.ceil(totalCount / pageSize)
        }
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Unexpected error in listGroupSchedules:", error);
    return serverErrorResponse(error.message);
  }
}

// Handler for GET /group-schedules/:id (getGroupSchedule)
async function handleGetGroupSchedule(req: Request) {
  try {
    const { user, token } = await getAuthenticatedUser(req);
    if (!user) {
      return unauthorizedResponse();
    }

    const supabaseClient = createAuthClient(token!);
    const url = new URL(req.url);
    const groupId = getGroupIdFromUrl(url);
    
    if (!groupId) {
      return badRequestResponse("Missing group ID");
    }

    // First check if user is the creator
    const { data: isCreator, error: creatorError } = await supabaseClient
      .from("group_schedules")
      .select("*")
      .eq("id", groupId)
      .eq("created_by", user.id)
      .maybeSingle();
      
    if (creatorError) {
      console.error("Error checking if user is creator:", creatorError);
      return serverErrorResponse(creatorError.message);
    }
    
    // If not creator, check if user is a member
    let isMember = false;
    if (!isCreator) {
      const { data: membership, error: memberError } = await supabaseClient
        .from("group_members")
        .select("*")
        .eq("group_id", groupId)
        .eq("user_id", user.id)
        .maybeSingle();
        
      if (memberError) {
        console.error("Error checking if user is member:", memberError);
        return serverErrorResponse(memberError.message);
      }
      
      isMember = !!membership;
    }
    
    // If neither creator nor member, return not found
    if (!isCreator && !isMember) {
      return notFoundResponse("Group schedule not found or you don't have access");
    }

    // Get group with related data
    const { data, error } = await supabaseClient
      .from("group_schedules")
      .select(`
        *,
        events:event_id (
          id,
          name, 
          date_start,
          date_end,
          venue,
          city,
          country,
          image_url
        )
      `)
      .eq("id", groupId)
      .single();

    if (error) {
      console.error("Error fetching group schedule:", error);
      return serverErrorResponse(error.message);
    }
    
    // Get members separately
    const { data: members, error: membersError } = await supabaseClient
      .from("group_members")
      .select(`
        id,
        user_id,
        is_admin,
        status,
        joined_at,
        created_at
      `)
      .eq("group_id", groupId);
      
    if (membersError) {
      console.error("Error fetching group members:", membersError);
      return serverErrorResponse(membersError.message);
    }
    
    // Combine the data
    const groupWithMembers = {
      ...data,
      members
    };

    return new Response(
      JSON.stringify(groupWithMembers),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Unexpected error in getGroupSchedule:", error);
    return serverErrorResponse(error.message);
  }
}

// Handler for POST /group-schedules (createGroupSchedule)
async function handleCreateGroupSchedule(req: Request) {
  try {
    const { user, token } = await getAuthenticatedUser(req);
    if (!user) {
      return unauthorizedResponse();
    }

    const supabaseClient = createAuthClient(token!);
    const body = await req.json() as GroupSchedule;
    const { name, event_id } = body;

    // Validate required fields
    if (!name) {
      return badRequestResponse("Missing required field: name");
    }
    
    if (!event_id) {
      return badRequestResponse("Missing required field: event_id");
    }

    // Create the group schedule with authenticated client
    const { data: group, error: groupError } = await supabaseClient
      .from("group_schedules")
      .insert([{
        name,
        event_id,
        created_by: user.id
      }])
      .select()
      .single();

    if (groupError) {
      // Check if error message contains RLS information
      if (groupError.message && groupError.message.includes("row-level security")) {
        console.error("RLS policy error creating group schedule:", groupError);
        return new Response(
          JSON.stringify({ 
            error: "Row Level Security policy violation. Please verify your RLS policies for group_schedules table.",
            details: groupError.message,
            suggestion: "Make sure you have a policy allowing users to create groups with themselves as created_by."
          }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        );
      }
      
      console.error("Error creating group schedule:", groupError);
      return serverErrorResponse(groupError.message);
    }

    // After successfully creating the group, add the user as an admin member
    const { error: memberError } = await supabaseClient
      .from("group_members")
      .insert([{
        group_id: group.id,
        user_id: user.id,
        is_admin: true,
        status: 'accepted',
        joined_at: new Date().toISOString()
      }]);

    if (memberError) {
      // Check if error message contains RLS information
      if (memberError.message && memberError.message.includes("row-level security")) {
        console.error("RLS policy error adding member:", memberError);
        
        // Clean up the created group since we couldn't add the member
        await supabaseClient
          .from("group_schedules")
          .delete()
          .eq("id", group.id);
          
        return new Response(
          JSON.stringify({ 
            error: "Row Level Security policy violation. Please verify your RLS policies for group_members table.",
            details: memberError.message,
            suggestion: "Make sure you have a policy allowing the group creator to add themselves as a member."
          }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        );
      }
      
      console.error("Error adding creator as member:", memberError);
      
      // Clean up the created group if member creation fails
      await supabaseClient
        .from("group_schedules")
        .delete()
        .eq("id", group.id);
        
      return serverErrorResponse(memberError.message);
    }

    return new Response(
      JSON.stringify({ 
        success: true, 
        group_schedule: group,
        message: "Group and initial membership created successfully."
      }),
      { status: 201, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Unexpected error in createGroupSchedule:", error);
    return serverErrorResponse(error.message);
  }
}

// Handler for PUT /group-schedules/:id (updateGroupSchedule)
async function handleUpdateGroupSchedule(req: Request) {
  try {
    const { user, token } = await getAuthenticatedUser(req);
    if (!user) {
      return unauthorizedResponse();
    }

    const supabaseClient = createAuthClient(token!);
    const url = new URL(req.url);
    const groupId = getGroupIdFromUrl(url);
    
    if (!groupId) {
      return badRequestResponse("Missing group ID");
    }

    const updates = await req.json() as Partial<GroupSchedule>;
    
    // Remove id from updates if present
    if (updates.id) {
      delete updates.id;
    }
    
    // Don't allow changing created_by
    if (updates.created_by) {
      delete updates.created_by;
    }

    // Check if user has permission (creator or admin)
    const { data: permissionCheck, error: permissionError } = await supabaseClient
      .from("group_schedules")
      .select("id, created_by")
      .eq("id", groupId)
      .eq("created_by", user.id)
      .maybeSingle();

    if (permissionError) {
      console.error("Error checking permissions:", permissionError);
      return serverErrorResponse(permissionError.message);
    }

    if (!permissionCheck) {
      // Check if user is admin
      const { data: adminCheck, error: adminError } = await supabaseClient
        .from("group_members")
        .select("id")
        .eq("group_id", groupId)
        .eq("user_id", user.id)
        .eq("is_admin", true)
        .maybeSingle();

      if (adminError) {
        console.error("Error checking admin status:", adminError);
        return serverErrorResponse(adminError.message);
      }

      if (!adminCheck) {
        return unauthorizedResponse();
      }
    }

    // Update group schedule
    const { data, error } = await supabaseClient
      .from("group_schedules")
      .update(updates)
      .eq("id", groupId)
      .select()
      .single();

    if (error) {
      console.error("Error updating group schedule:", error);
      return serverErrorResponse(error.message);
    }

    return new Response(
      JSON.stringify({ success: true, group_schedule: data }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Unexpected error in updateGroupSchedule:", error);
    return serverErrorResponse(error.message);
  }
}

// Handler for DELETE /group-schedules/:id (deleteGroupSchedule)
async function handleDeleteGroupSchedule(req: Request) {
  try {
    const { user, token } = await getAuthenticatedUser(req);
    if (!user) {
      return unauthorizedResponse();
    }

    const supabaseClient = createAuthClient(token!);
    const url = new URL(req.url);
    const groupId = getGroupIdFromUrl(url);
    
    if (!groupId) {
      return badRequestResponse("Missing group ID");
    }

    // Check if user has permission (must be creator)
    const { data: permissionCheck, error: permissionError } = await supabaseClient
      .from("group_schedules")
      .select("id")
      .eq("id", groupId)
      .eq("created_by", user.id)
      .maybeSingle();

    if (permissionError) {
      console.error("Error checking permissions:", permissionError);
      return serverErrorResponse(permissionError.message);
    }

    if (!permissionCheck) {
      return unauthorizedResponse();
    }

    // Delete group schedule (cascades to members, votes, etc. based on FK constraints)
    const { error } = await supabaseClient
      .from("group_schedules")
      .delete()
      .eq("id", groupId);

    if (error) {
      console.error("Error deleting group schedule:", error);
      return serverErrorResponse(error.message);
    }

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Unexpected error in deleteGroupSchedule:", error);
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

    // Extract group ID from URL
    const groupId = getGroupIdFromUrl(url);
    
    // Check URL patterns
    const isBaseRoute = (path === "/group-schedules" || path === "/group-schedules/");
    const isSpecificRoute = groupId !== null;
    
    // Route requests to appropriate handlers
    if (isBaseRoute && method === "GET") {
      return await handleListGroupSchedules(req);
    } else if (isBaseRoute && method === "POST") {
      return await handleCreateGroupSchedule(req);
    } else if (isSpecificRoute && method === "GET") {
      return await handleGetGroupSchedule(req);
    } else if (isSpecificRoute && method === "PUT") {
      return await handleUpdateGroupSchedule(req);
    } else if (isSpecificRoute && method === "DELETE") {
      return await handleDeleteGroupSchedule(req);
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

  # List Group Schedules (Authenticated)
  curl -i --location --request GET 'http://127.0.0.1:54321/functions/v1/group-schedules?event_id=1&page=1&pageSize=10' \
    --header 'Authorization: Bearer YOUR_AUTH_TOKEN'

  # Get Group Schedule Details (Authenticated)
  curl -i --location --request GET 'http://127.0.0.1:54321/functions/v1/group-schedules/1' \
    --header 'Authorization: Bearer YOUR_AUTH_TOKEN'

  # Create Group Schedule (Authenticated)
  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/group-schedules' \
    --header 'Authorization: Bearer YOUR_AUTH_TOKEN' \
    --header 'Content-Type: application/json' \
    --data '{"name":"Our Festival Squad","event_id":1}'

  # Update Group Schedule (Authenticated, Creator or Admin only)
  curl -i --location --request PUT 'http://127.0.0.1:54321/functions/v1/group-schedules/1' \
    --header 'Authorization: Bearer YOUR_AUTH_TOKEN' \
    --header 'Content-Type: application/json' \
    --data '{"name":"Updated Squad Name"}'

  # Delete Group Schedule (Authenticated, Creator only)
  curl -i --location --request DELETE 'http://127.0.0.1:54321/functions/v1/group-schedules/1' \
    --header 'Authorization: Bearer YOUR_AUTH_TOKEN'
*/
