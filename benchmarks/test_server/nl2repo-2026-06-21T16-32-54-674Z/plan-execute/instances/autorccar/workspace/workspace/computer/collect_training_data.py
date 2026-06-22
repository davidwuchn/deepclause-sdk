"""
AutoRCCar - Training Data Collection Module

Collects training data by receiving video stream from Raspberry Pi,
capturing keyboard-driven control commands, and saving image-label pairs
as .npz files for neural network training.
"""

import cv2
import numpy as np
import serial
import socket
import os
import time
import pygame
from pygame.locals import K_UP, K_DOWN, K_LEFT, K_RIGHT, K_x, K_q


class CollectTrainingData(object):
    """
    Collects training data for the autonomous RC car neural network.
    
    Receives video stream from Raspberry Pi camera, captures keyboard
    control inputs via pygame, and saves image-label pairs as .npz files.
    
    Control keys:
        UP arrow:  Forward  (label 2)
        DOWN arrow: Backward (label 3)
        LEFT arrow: Left turn (label 0)
        RIGHT arrow: Right turn (label 1)
        'q' or 'x': Quit collection
    
    Attributes:
        host (str): Server host address for video stream reception
        port (int): Server port for video stream
        serial_port (str): Arduino serial port device path
        input_size (int): Flattened image size (number of pixels)
        k (np.ndarray): 4x4 identity label matrix for one-hot encoding
        data_counter (int): Counter for naming saved data files
    """

    def __init__(self, host, port, serial_port, input_size):
        """
        Initialize the training data collector.
        
        Args:
            host (str): Host address for the data collection server
            port (int): Port for the data collection server
            serial_port (str): Path to the Arduino serial port device
                e.g., "/dev/tty.usbmodem1421"
            input_size (int): Size of the input image (number of pixels)
                e.g., 120 * 320 = 38400 for half-image ROI
        """
        self.host = host
        self.port = port
        self.serial_port = serial_port
        self.input_size = input_size
        
        # Server socket setup - bind and listen for incoming connections
        self.server_socket = socket.socket()
        self.server_socket.bind((self.host, self.port))
        self.server_socket.listen(0)
        print(f"Server listening on {self.host}:{self.port}")
        
        # Serial port connection configuration
        try:
            self.ser = serial.Serial(self.serial_port, 115200, timeout=1)
            print(f"Serial port opened: {self.serial_port}")
        except serial.SerialException as e:
            print(f"Warning: Could not open serial port {self.serial_port}: {e}")
            print("Proceeding without serial control (keyboard-only mode)")
            self.ser = None
        
        # Input size configuration
        # Expected image dimensions: width x height
        # For input_size = 120 * 320: width=320, height=120 (lower half of 240x320 image)
        self.width = 320
        self.height = self.input_size // self.width
        
        # Label matrix configuration - 4x4 identity matrix for one-hot encoding
        # Row mapping: 0=left, 1=right, 2=forward, 3=stop/backward
        self.k = np.zeros((4, 4), 'float')
        for i in range(4):
            self.k[i, i] = 1
        
        # Data collection counter
        self.data_counter = 0
        
        # Training data directory
        self.data_dir = "training_data"
        if not os.path.exists(self.data_dir):
            os.makedirs(self.data_dir)
            print(f"Created training data directory: {self.data_dir}")
        
        # Pygame initialization for keyboard input
        pygame.init()
        self.screen = pygame.display.set_mode((640, 480))
        pygame.display.set_caption("AutoRCCar - Data Collection")
        print("Pygame initialized - use arrow keys to drive, 'q' or 'x' to quit")
        
        # Current label index (default: forward = 2)
        self.current_label = 2
        
        # Stream buffer
        self.stream_bytes = b' '

    def _decode_frame(self):
        """
        Decode a single JPEG frame from the stream buffer.
        
        Returns:
            tuple: (gray_image, color_image) or (None, None) if no complete frame
        """
        first = self.stream_bytes.find(b'\xff\xd8')
        last = self.stream_bytes.find(b'\xff\xd9')
        
        if first != -1 and last != -1:
            jpg = self.stream_bytes[first:last + 2]
            self.stream_bytes = self.stream_bytes[last + 2:]
            
            gray = cv2.imdecode(np.frombuffer(jpg, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
            image = cv2.imdecode(np.frombuffer(jpg, dtype=np.uint8), cv2.IMREAD_COLOR)
            
            return gray, image
        
        return None, None

    def _process_pygame_events(self):
        """
        Process pygame keyboard events and update the current label.
        
        Returns:
            bool: True if quit was pressed, False otherwise
        """
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                return True
        
        keys = pygame.key.get_pressed()
        
        if keys[K_q] or keys[K_x]:
            return True
        
        if keys[K_UP]:
            self.current_label = 2  # Forward
        elif keys[K_DOWN]:
            self.current_label = 3  # Backward
        elif keys[K_LEFT]:
            self.current_label = 0  # Left
        elif keys[K_RIGHT]:
            self.current_label = 1  # Right
        
        return False

    def _send_serial_command(self):
        """
        Send the current control command to the Arduino via serial port.
        """
        if self.ser is None:
            return
        
        try:
            if self.current_label == 2:
                self.ser.write(chr(1).encode())  # Forward
            elif self.current_label == 0:
                self.ser.write(chr(7).encode())  # Left
            elif self.current_label == 1:
                self.ser.write(chr(6).encode())  # Right
            elif self.current_label == 3:
                self.ser.write(chr(2).encode())  # Backward
        except serial.SerialException as e:
            print(f"Serial error: {e}")

    def _extract_roi(self, gray):
        """
        Extract the Region of Interest (lower half) from the grayscale image.
        
        Args:
            gray (np.ndarray): Grayscale image from camera
            
        Returns:
            np.ndarray: ROI image (lower half)
        """
        h, w = gray.shape
        # Take the lower half of the image for the driving ROI
        roi = gray[int(h / 2):h, :]
        return roi

    def _save_data(self, roi, label):
        """
        Save an image-label pair as a .npz file.
        
        Args:
            roi (np.ndarray): The ROI image array
            label (int): The control label (0=left, 1=right, 2=forward, 3=stop)
        """
        # Flatten the ROI to a 1D array
        image_array = roi.flatten().astype(np.float32)
        
        # Pad or truncate to match input_size
        if len(image_array) < self.input_size:
            image_array = np.pad(image_array, (0, self.input_size - len(image_array)), 'constant')
        elif len(image_array) > self.input_size:
            image_array = image_array[:self.input_size]
        
        # Create one-hot encoded label
        label_array = self.k[label].astype(np.float32)
        
        # Save as npz file
        filename = os.path.join(self.data_dir, f"data_{self.data_counter:06d}.npz")
        np.savez(filename, image=image_array, label=label_array)
        self.data_counter += 1
        
        return filename

    def collect(self):
        """
        Main data collection loop.
        
        Connects to the Raspberry Pi video stream, displays frames with
        pygame, captures keyboard inputs, sends commands to Arduino,
        and saves image-label pairs for training.
        
        Usage:
            ctd = CollectTrainingData("192.168.1.100", 8000, "/dev/tty.usbmodem1421", 38400)
            ctd.collect()
        """
        print("\n=== AutoRCCar Training Data Collection ===")
        print("Controls:")
        print("  UP arrow   -> Forward  (label 2)")
        print("  DOWN arrow -> Backward (label 3)")
        print("  LEFT arrow -> Left     (label 0)")
        print("  RIGHT arrow-> Right    (label 1)")
        print("  'q' or 'x' -> Quit collection")
        print("==========================================\n")
        
        # Accept incoming connection
        try:
            connection, client_address = self.server_socket.accept()
            print(f"Connected to: {client_address}")
        except OSError as e:
            print(f"Error accepting connection: {e}")
            return
        
        stream = connection.makefile('rb', 0)
        
        try:
            while True:
                # Check for quit
                should_quit = self._process_pygame_events()
                if should_quit:
                    print("\nQuit signal received. Stopping data collection.")
                    break
                
                # Read from stream
                data = stream.read(1024)
                if not data:
                    print("Stream disconnected")
                    break
                
                self.stream_bytes += data
                
                # Decode frame
                gray, image = self._decode_frame()
                
                if gray is None or image is None:
                    continue
                
                # Extract ROI
                roi = self._extract_roi(gray)
                
                # Send control command to Arduino
                self._send_serial_command()
                
                # Display the image with pygame
                # Convert BGR (OpenCV) to RGB (pygame), resize to display size
                image_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
                image_resized = cv2.resize(image_rgb, (640, 480))
                surface = pygame.surfarray.make_surface(image_resized.swapaxes(0, 1))
                self.screen.blit(surface, (0, 0))
                
                # Draw label indicator on the image
                label_names = ['LEFT', 'RIGHT', 'FORWARD', 'BACKWARD']
                label_colors = [
                    (255, 0, 0),   # Red for left
                    (0, 0, 255),   # Blue for right
                    (0, 255, 0),   # Green for forward
                    (255, 255, 0), # Yellow for backward
                ]
                
                # Draw on OpenCV image for overlay
                overlay = image.copy()
                cv2.putText(overlay, label_names[self.current_label],
                           (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 1.0,
                           (0, 255, 0), 2)
                cv2.putText(overlay, f"Data: {self.data_counter}",
                           (10, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.7,
                           (0, 255, 0), 2)
                
                # Convert overlay for pygame display
                overlay_rgb = cv2.cvtColor(overlay, cv2.COLOR_BGR2RGB)
                overlay_resized = cv2.resize(overlay_rgb, (640, 480))
                surface = pygame.surfarray.make_surface(overlay_resized.swapaxes(0, 1))
                self.screen.blit(surface, (0, 0))
                
                pygame.display.update()
                
                # Save data periodically (every frame where user is pressing a key)
                keys = pygame.key.get_pressed()
                if keys[K_UP] or keys[K_DOWN] or keys[K_LEFT] or keys[K_RIGHT]:
                    filename = self._save_data(roi, self.current_label)
                    # Flash a small indicator that data was saved
                    print(f"  Saved: {os.path.basename(filename)} [label={self.current_label}]")
                
                # Small delay to control collection rate
                time.sleep(0.05)
                
        except KeyboardInterrupt:
            print("\n\nKeyboard interrupt received. Stopping data collection.")
        except Exception as e:
            print(f"Error during collection: {e}")
        finally:
            # Cleanup
            try:
                stream.close()
                connection.close()
            except Exception:
                pass
            
            if self.ser is not None:
                try:
                    self.ser.write(chr(0).encode())  # Stop the car
                    self.ser.close()
                except Exception:
                    pass
            
            pygame.quit()
            
            print(f"\n=== Collection Complete ===")
            print(f"Total samples collected: {self.data_counter}")
            print(f"Data directory: {self.data_dir}/")

    def collect_batch(self, samples_per_action=100, delay=0.1):
        """
        Collect a batch of samples for each action type automatically.
        
        Args:
            samples_per_action (int): Number of samples to collect per action
            delay (float): Delay between samples in seconds
        """
        actions = [
            (2, "FORWARD"),
            (0, "LEFT"),
            (1, "RIGHT"),
            (3, "BACKWARD"),
        ]
        
        print("\n=== AutoRCCar Batch Data Collection ===")
        print(f"Samples per action: {samples_per_action}")
        print("Press 'q' or 'x' to stop early\n")
        
        # Accept connection
        try:
            connection, client_address = self.server_socket.accept()
            print(f"Connected to: {client_address}")
        except OSError as e:
            print(f"Error accepting connection: {e}")
            return
        
        stream = connection.makefile('rb', 0)
        
        try:
            for label, name in actions:
                if self.data_counter == 0:
                    print(f"\nCollecting {name} samples...")
                
                self.current_label = label
                
                # Send command
                self._send_serial_command()
                
                for _ in range(samples_per_action):
                    # Check quit
                    if self._process_pygame_events():
                        break
                    
                    # Read stream
                    data = stream.read(1024)
                    if not data:
                        break
                    self.stream_bytes += data
                    
                    gray, image = self._decode_frame()
                    if gray is None:
                        continue
                    
                    roi = self._extract_roi(gray)
                    filename = self._save_data(roi, label)
                    print(f"  {name}: Saved {self.data_counter}")
                    
                    time.sleep(delay)
                
                # Reset to stop
                if self.ser is not None:
                    self.ser.write(chr(0).encode())
                
        except KeyboardInterrupt:
            print("\nInterrupted.")
        finally:
            stream.close()
            connection.close()
            pygame.quit()
            print(f"\nCollected {self.data_counter} samples total.")


if __name__ == '__main__':
    # Default configuration
    # host, port for receiving video stream
    host = "192.168.1.100"
    port = 8000
    
    # Serial port for Arduino RC car control
    serial_port = "/dev/tty.usbmodem1421"
    
    # Input size: half of a 240x320 image = 120 * 320 = 38400
    # Adjust based on your camera resolution
    input_size = 120 * 320
    
    print("AutoRCCar - Training Data Collection Tool")
    print(f"Host: {host}, Port: {port}")
    print(f"Serial: {serial_port}, Input size: {input_size}")
    print()
    
    try:
        ctd = CollectTrainingData(host, port, serial_port, input_size)
        ctd.collect()
    except Exception as e:
        print(f"Fatal error: {e}")
        import traceback
        traceback.print_exc()
