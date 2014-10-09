'use strict';

// Configuring the Messages module
angular.module('messages').run(['Menus',
	function(Menus) {
		// Set top bar menu items
		// This menu has only icon and no text label
		Menus.addMenuItem('topuserbar', '', 'messages', 'messages', 'messages', null, null, 0, 'comments fa-lg');
	}
]);
