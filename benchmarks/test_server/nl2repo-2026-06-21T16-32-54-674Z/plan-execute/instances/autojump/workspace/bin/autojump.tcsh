# autojump.tcsh - TCsh integration for autojump
# This script provides j, jc, jo, jco shell functions and tab completion

# Set environment variables
setenv AUTOJUMP_VERSION "22.5.3"
setenv AUTOJUMP_SHELL "tcsh"
setenv AUTOJUMP_COMPLETION "${AUTOJUMP_COMPLETION:-on}"

# Tab menu support
if ( -z "$AUTOJUMP_NO_TAB_MENU" ) then
    setenv AUTOJUMP_NO_TAB_MENU 0
endif

# Locate the autojump binary
if ( -n "$AUTOJUMP_BIN" ) then
    set _AUTOJUMP_DIR = ( `dirname "$AUTOJUMP_BIN"` )
else if ( `which autojump 2>/dev/null` ) then
    set _AUTOJUMP_DIR = ( `dirname \`which autojump\`` )
else
    set _AUTOJUMP_DIR = ( `dirname "$0"` )
endif

# Locate the autojump.sh helper
if ( -n "$AUTOJUMP_PATH" ) then
    setenv AUTOJUMP_DATA_FILE "$AUTOJUMP_PATH"
endif

# Core jump function
alias _j 'set _j_output=`autojump \!* 2>/dev/null`; \
    if ( $status == 0 && -n "$_j_output" ) then \
        if ( "$_j_output" =~ "*autojump: error*" || "$_j_output" =~ "*No matches*" ) then \
            exit 1; \
        else if ( "$_j_output" =~ "*\$" ) then \
            eval "$_j_output"; \
        else \
            cd "$_j_output"; \
        endif \
    endif; \
    exit $status'

# Jump to directory
alias j '_j \!*'

# Jump to child directory
alias jc '_j --children \!*'

# Open in file manager
alias jo 'set _jo_output=`autojump \!* 2>/dev/null`; \
    if ( $status == 0 && -n "$_jo_output" ) then \
        if ( "`uname -s`" == "Darwin" ) then \
            open "$_jo_output"; \
        else if ( "`uname -s`" == "Linux" ) then \
            if ( `which xdg-open 2>/dev/null` ) then \
                xdg-open "$_jo_output"; \
            else if ( `which nautilus 2>/dev/null` ) then \
                nautilus "$_jo_output"; \
            else if ( `which dolphin 2>/dev/null` ) then \
                dolphin "$_jo_output"; \
            else if ( `which thunar 2>/dev/null` ) then \
                thunar "$_jo_output"; \
            else \
                echo "autojump: no file manager found"; \
                exit 1; \
            endif; \
        else \
            echo "autojump: file manager not supported on this platform"; \
            exit 1; \
        endif; \
    endif; \
    exit $status'

# Open child directory in file manager
alias jco 'set _jco_output=`autojump --children \!* 2>/dev/null`; \
    if ( $status == 0 && -n "$_jco_output" ) then \
        if ( "`uname -s`" == "Darwin" ) then \
            open "$_jco_output"; \
        else if ( "`uname -s`" == "Linux" ) then \
            if ( `which xdg-open 2>/dev/null` ) then \
                xdg-open "$_jco_output"; \
            else if ( `which nautilus 2>/dev/null` ) then \
                nautilus "$_jco_output"; \
            else if ( `which dolphin 2>/dev/null` ) then \
                dolphin "$_jco_output"; \
            else if ( `which thunar 2>/dev/null` ) then \
                thunar "$_jco_output"; \
            else \
                echo "autojump: no file manager found"; \
                exit 1; \
            endif; \
        else \
            echo "autojump: file manager not supported on this platform"; \
            exit 1; \
        endif; \
    endif; \
    exit $status'

# Add current directory to autojump database
alias _j_add 'autojump --add `pwd -P` > /dev/null 2>&1'

# Track directory changes
alias cd 'command cd \!* && _j_add'
alias pushd 'command pushd \!* > /dev/null 2>&1 && _j_add'
alias popd 'command popd \!* > /dev/null 2>&1 && _j_add'

# Add current directory on load
_j_add

# Tab completion for tcsh (using fcomplete if available)
if ( "$AUTOJUMP_COMPLETION" != "off" ) then
    # tcsh completion using autojump --complete
    if ( $?fish_complete_type ) then
        # Fish-style completion not available in tcsh, use basic completion
    endif

    # Basic directory completion fallback
    complete j 'n/*/p/\!*' 'p/*/' 2>/dev/null
    complete jc 'n/*/p/\!*' 'p/*/' 2>/dev/null
    complete jo 'n/*/p/\!*' 'p/*/' 2>/dev/null
    complete jco 'n/*/p/\!*' 'p/*/' 2>/dev/null
endif

# Version function
alias autojump-version 'echo "autojump $AUTOJUMP_VERSION"'

# Display information
alias _j_info 'echo "autojump $AUTOJUMP_VERSION"; \
    echo "Data file: $AUTOJUMP_DATA_FILE"; \
    echo "Shell: tcsh"; \
    echo "Autojump script: $0"'

# End of autojump.tcsh
