-- autojump.lua - Clink integration for autojump
-- For use with Windows Clink shell enhancer

local autojump_path = nil

-- Auto-detect autojump binary location
local function find_autojump()
    if autojump_path then
        return autojump_path
    end

    -- Check common locations
    local locations = {
        os.getenv("AUTOJUMP_PATH"),
        os.getenv("LOCALAPPDATA") .. "\\autojump\\bin",
        os.getenv("APPDATA") .. "\\autojump\\bin",
        os.getenv("ProgramFiles") .. "\\autojump",
    }

    for _, loc in ipairs(locations) do
        if loc and os.execute('where "' .. loc .. "\\autojump.exe"') == 0 then
            autojump_path = loc
            return loc
        end
    end

    -- Try PATH
    if os.execute('where autojump.exe') == 0 then
        return nil  -- Use system PATH
    end

    return nil
end

-- Jump to directory
function j(...)
    local args = {...}
    local query = table.concat(args, " ")

    if query == "" or query == "-h" or query == "--help" then
        print("Usage: j <query>")
        print("Jump to a directory matching the query.")
        return
    end

    local autojump = find_autojump()
    local cmd
    if autojump then
        cmd = '"' .. autojump .. "\\autojump.bat" .. '" ' .. query
    else
        cmd = 'autojump ' .. query
    end

    local result = io.popen(cmd)
    if result then
        local dir = result:read("*a"):gsub("[\r\n]+$", "")
        if dir and dir ~= "" then
            os.execute('cd /d "' .. dir .. '"')
        else
            print("autojump: could not find directory matching '" .. query .. "'")
        end
        result:close()
    end
end

-- Jump to child directory
function jc(...)
    local args = {...}
    local query = table.concat(args, " ")

    if query == "" or query == "-h" or query == "--help" then
        print("Usage: jc <query>")
        print("Jump to a child directory matching the query.")
        return
    end

    local autojump = find_autojump()
    local cmd
    if autojump then
        cmd = '"' .. autojump .. "\\autojump.bat" .. '" --children ' .. query
    else
        cmd = 'autojump --children ' .. query
    end

    local result = io.popen(cmd)
    if result then
        local dir = result:read("*a"):gsub("[\r\n]+$", "")
        if dir and dir ~= "" then
            os.execute('cd /d "' .. dir .. '"')
        else
            print("autojump: could not find directory matching '" .. query .. "'")
        end
        result:close()
    end
end

-- Open directory in file manager
function jo(...)
    local args = {...}
    local query = table.concat(args, " ")

    if query == "" or query == "-h" or query == "--help" then
        print("Usage: jo <query>")
        print("Open a directory in the file manager.")
        return
    end

    local autojump = find_autojump()
    local cmd
    if autojump then
        cmd = '"' .. autojump .. "\\autojump.bat" .. '" ' .. query
    else
        cmd = 'autojump ' .. query
    end

    local result = io.popen(cmd)
    if result then
        local dir = result:read("*a"):gsub("[\r\n]+$", "")
        if dir and dir ~= "" then
            os.execute('explorer "' .. dir .. '"')
        else
            print("autojump: could not find directory matching '" .. query .. "'")
        end
        result:close()
    end
end

-- Register commands with clink
clink.register_promptfilter(function()
    -- Track current directory
    local autojump = find_autojump()
    if autojump then
        local cmd = '"' .. autojump .. "\\autojump.bat" .. '" --add "' .. os.getenv("PWD") .. '"'
        os.execute(cmd .. " 2>nul")
    end
end)
