import { Icon, type IconProps } from "./Icon";

/** Material Symbols Rounded "folder", filled: weight 400, 24px optical size. */
export function FolderFilledIcon(props: IconProps) {
	return (
		<Icon {...props}>
			<path d="M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h207q16 0 30.5 6t25.5 17l57 57h320q33 0 56.5 23.5T880-640v400q0 33-23.5 56.5T800-160H160Z" />
		</Icon>
	);
}
